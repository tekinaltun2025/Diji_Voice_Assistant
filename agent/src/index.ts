// DIKKAT: Bu import TUM diger importlardan once gelmelidir.
// `@diji/shared` yapilandirmasi modul yukleme aninda `process.env`'i okur;
// bu yuzden `~/.config/diji/env` dosyasi o degerlendirilmeden once
// yuklenmis olmalidir. Aksi halde env dosyasindaki DIJI_TTS_SPEED gibi
// degerler ajana hic ulasmaz (yalnizca calisma aninda okunan anahtarlar
// etkilenir).
import './env-bootstrap';
import { loadUserEnv } from './env-bootstrap';
import * as readline from 'readline';
import { AgentConfig } from '@diji/shared';
import { logger, logInfo, logError, logWarn } from '@diji/shared';
import { VoicePipeline, createVoicePipeline } from './pipeline';
import { LLMEngine, createLLMEngine } from './llm';
import { STTEngine, createSTTEngine } from './stt';
import { TTSEngine, createTTSEngine } from './tts';
import { VADProcessor, createVADProcessor } from './vad';
import { TurkishTurnDetector, createTurkishTurnDetector } from './turn-detector';
import { MCPClient, createMCPClient } from './mcp-client';
import { telemetry } from './telemetry';
import { startControlServer, type ControlServerHandle } from './control-server';

export {
  VoicePipeline,
  createVoicePipeline,
  LLMEngine,
  createLLMEngine,
  STTEngine,
  createSTTEngine,
  TTSEngine,
  createTTSEngine,
  VADProcessor,
  createVADProcessor,
  TurkishTurnDetector,
  createTurkishTurnDetector,
  MCPClient,
  createMCPClient,
};

let pipeline: VoicePipeline | null = null;
let controlHandle: ControlServerHandle | null = null;

async function main(): Promise<void> {
  try {
    // Kalıcı kullanıcı ayarları (başlatıcıdan bağımsız): ~/.config/diji/env
    // Yukleme zaten `./env-bootstrap` import'u sirasinda yapildi; burada
    // tekrar cagirmak zararsizdir (idempotent) ve modul sirasindan bagimsiz
    // guvence saglar. Örn. DIJI_TTS_ENABLED=0 → seslendirme kapalı.
    loadUserEnv();

    logInfo('Diji Voice Agent baslatiliyor...');

    // Konfigurasyonu yukle
    const configLoader = (await import('@diji/shared')).configLoader;
    const config: AgentConfig = configLoader.getConfig();

    logInfo('Konfigurasyon yuklendi', {
      livekitUrl: config.livekit.url,
      llmModel: config.llm.model,
      sttModel: config.stt.model,
      ttsModel: config.tts.model,
      mcpEnabled: config.mcp.enabled,
    });

    // Pipeline'i olustur ve baslat
    pipeline = createVoicePipeline(config);
    await pipeline.start();

    logInfo('Diji Voice Agent baslatildi', {
      sessionId: pipeline.getSessionId(),
    });

    // Kontrol + telemetri sunucusu: arayüz (Electron) ajanı buradan yönetir
    // ve canlı aşama durumlarını (SSE) buradan alır. Açılmazsa ajan yine
    // çalışır; arayüz "ajan bağlı değil" gösterir.
    try {
      controlHandle = await startControlServer(() => pipeline);
    } catch (error) {
      logError('Kontrol sunucusu acilamadi (arayuz baglanamayacak)', error as Error, {
        port: process.env.DIJI_CONTROL_PORT || 8899,
      });
    }

    // Calisma modu:
    //   DIJI_MODE=microphone (varsayilan) -> mikrofon + hoparlor
    //   DIJI_MODE=text                   -> terminalden yazarak (mikrofon yok)
    const mode = (process.env.DIJI_MODE || 'microphone').toLowerCase();

    if (mode === 'text') {
      await startTextMode(pipeline);
    } else {
      await startMicrophoneMode(pipeline);
    }

    // Graceful shutdown handler'lari
    process.on('SIGINT', async () => {
      logInfo('SIGINT alindi, agent durduruluyor...');
      await shutdown();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logInfo('SIGTERM alindi, agent durduruluyor...');
      await shutdown();
      process.exit(0);
    });

    process.on('uncaughtException', async (error: Error) => {
      logError('Yakalanamayan hata', error);
      await shutdown();
      process.exit(1);
    });

    process.on('unhandledRejection', async (reason: unknown) => {
      logError('Yakalanamayan promise reddi', reason as Error);
      await shutdown();
      process.exit(1);
    });
  } catch (error) {
    logError('Agent baslatilamadi', error as Error);
    process.exit(1);
  }
}

/**
 * Mikrofon + hoparlor modu (gercek sesli asistan).
 * `arecord`/`aplay` yoksa acik hata verir ve text moduna yonlendirir.
 */
async function startMicrophoneMode(p: VoicePipeline): Promise<void> {
  try {
    await p.startListening();
    telemetry.update('agent', 'active', 'sesli mod hazır — mikrofon dinliyor');
    telemetry.log('info', 'agent', 'sesli mod hazır');
    logInfo('Sesli mod hazir — konusabilirsiniz (cikmak icin Ctrl+C)');
  } catch (error) {
    // Mikrofon açılamadı diye süreç ölmez: arayüzdeki teşhis paneli hatayı
    // gösterir ve kullanıcı "dinlemeyi başlat" ile yeniden deneyebilir
    // (cihaz başka bir uygulama tarafından meşgul edilmiş olabilir).
    logError('Mikrofon baslatilamadi', error as Error, {
      hint:
        'ALSA araclari kurulu mu?  sudo apt install alsa-utils\n' +
        'Cihaz listesi: arecord -l\n' +
        'Cihazi baska bir uygulama tutuyor olabilir (fuser -v /dev/snd/*).',
    });
    const msg = (error as Error).message;
    telemetry.update('mic', 'error', msg);
    telemetry.log('error', 'mic', msg);
    telemetry.update('agent', 'warn', 'mikrofon açılamadı — arayüzden yeniden deneyin');
    // Süreci canlı tut: kontrol sunucusu dinlemeye devam etsin.
    setInterval(() => undefined, 1 << 30);
  }
}

/**
 * Metin modu — mikrofon/hoparlor olmadan, terminalden yazarak test.
 * Sesli boru hattinin (STT/TTS) atlandigi; LLM + MCP + turn detector
 * zincirinin saglamligini hizli dogrulamak icin kullanilir.
 *
 * Not: `readline` `line` olayini beklemeden ardisik tetikler. Bu yuzden
 * satirlar bir Promise kuyruguna alinir; aksi halde uzun suren bir LLM
 * turu sirasinda gelen `/quit` (ya da bir sonraki soru) onceki turu
 * keser ve "LLM engine baslatilmamis" gibi kapanis hatalari olusur.
 */
async function startTextMode(p: VoicePipeline): Promise<void> {
  logWarn(
    'Metin modu etkin — mikrofon/hoparlor kullanilmiyor. ' +
      'Sesli mod icin DIJI_MODE=microphone (varsayilan).'
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr, // stdout protokole ayrilmis olabilir; stderr guvenli
    prompt: 'Sen> ',
  });

  const write = (text: string): void => {
    process.stderr.write(text);
  };

  /** Satir isleme kuyrugu: tek seferde tek tur islenir. */
  let queue: Promise<void> = Promise.resolve();
  /** Onay bekleniyor mu? O anda girilen satir cevap olarak yorumlanir. */
  let pendingConfirmation = false;

  // Tur tamamlandiginda yaniti terminalde goster.
  p.on('llm-complete', (event) => {
    const data = event.data as { response?: string };
    const response = (data?.response ?? '').trim();
    if (response) write(`\nDiji> ${response}\n`);
  });

  p.on('stt-final', (event) => {
    const data = event.data as { text?: string };
    if (data?.text) write(`\n[duyulan] ${data.text}\n`);
  });

  p.on('error', (event) => {
    const data = event.data as { error?: string };
    if (data?.error) write(`\n[hata] ${data.error}\n`);
  });

  // Onay gerektiren islemler: sonraki satir cevap olarak okunur.
  // `rl.question` kullanilmaz — satir kuyrugunu ve prompt dongusunu bozar.
  p.on('mcp-confirmation-required', (event) => {
    const data = event.data as { question?: string };
    pendingConfirmation = true;
    write(
      `\n${data?.question ?? 'Onay gerekiyor'}\nOnayliyor musun? (e/h): `
    );
  });

  const handleLine = async (line: string): Promise<void> => {
    const text = line.trim();
    if (!text) return;

    if (pendingConfirmation) {
      pendingConfirmation = false;
      const confirmed = /^(e|evet|y|yes)$/i.test(text);
      p.confirmPendingAction(confirmed);
      write(confirmed ? 'Onaylandi.\n' : 'Iptal edildi.\n');
      return;
    }

    if (text === '/quit' || text === '/exit' || text === '/cikis') {
      rl.close();
      await shutdown();
      process.exit(0);
    }

    if (text === '/stats') {
      write(`\n${JSON.stringify(p.getAudioStats(), null, 2)}\n`);
      return;
    }

    if (text === '/help' || text === '/yardim') {
      write('\nKomutlar: /help  /stats  /quit\n');
      return;
    }

    try {
      await p.processText(text);
    } catch (error) {
      logError('Metin isleme hatasi', error as Error);
    }
  };

  rl.on('line', (line) => {
    queue = queue
      .then(() => handleLine(line))
      .catch((error: unknown) => {
        logError('Satir isleme hatasi', error as Error);
      })
      .then(() => {
        rl.prompt();
      });
  });

  rl.on('close', () => {
    logInfo('Metin modu kapatildi');
  });

  rl.prompt();
  logInfo('Metin modu hazir — yazin ve Enter\'a basin (/quit ile cikis)');
}

/** Kapanis tek sefer calisir: SIGINT + /quit ayni anda gelebilir. */
let shutdownStarted = false;

async function shutdown(): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;

  logInfo('Agent kapatiliyor...');

  if (controlHandle) {
    try {
      await controlHandle.close();
    } catch {
      /* yoksay */
    }
    controlHandle = null;
  }

  if (pipeline) {
    try {
      await pipeline.dispose();
    } catch (error) {
      logError('Kapanis sirasinda hata', error as Error);
    }
    pipeline = null;
  }

  logInfo('Agent kapatildi');
}

// Main fonksiyonu calistir
main().catch((error: Error) => {
  logError('Main fonksiyonunda hata', error);
  process.exit(1);
});

export { pipeline, shutdown };