/**
 * Kontrol + telemetri sunucusu (yalnızca 127.0.0.1).
 *
 * Arayüz (Electron) bu uç noktalar üzerinden ajanı yönetir ve canlı durum
 * akışını (SSE) alır. Böylece UI süreci mikrofonu doğrudan açmaz: ses
 * boru hattının tek sahibi ajandır.
 *
 *   GET  /health        -> { ok, pid, uptime }
 *   GET  /state         -> anlık tam durum (pipeline + ses + telemetri + ttsEnabled)
 *   GET  /events        -> SSE: önce `snapshot`, sonra `stage` / `log` olayları
 *   POST /listen        -> { enabled: boolean } mikrofonu aç/kapat
 *   POST /ask           -> { text: string } metin turu (mikrofonsuz test)
 *   POST /tts           -> { enabled: boolean } TTS aç/kapat (null → env'e dön)
 *   POST /confirm       -> { confirmed: boolean } bekleyen MCP onayı
 *   POST /bargein       -> çalan sesi kes
 *   POST /inject        -> gövdedeki PCM16/16 kHz mono sesi mikrofon gibi besle (teşhis)
 */
import http from 'node:http';
import {
  CONVERSATION_LIMIT,
  telemetry,
  STAGE_ORDER,
  type ConversationEntry,
  type StageKey,
} from './telemetry';
import type { VoicePipeline } from './pipeline';
import { logError, logInfo } from '@diji/shared';

export const DEFAULT_CONTROL_PORT = Number(process.env.DIJI_CONTROL_PORT || 8899);
export const CONTROL_HOST = '127.0.0.1';

type PipelineGetter = () => VoicePipeline | null;

interface Client {
  id: number;
  res: http.ServerResponse;
}

export interface ControlServerHandle {
  port: number;
  close: () => Promise<void>;
}

export function startControlServer(
  getPipeline: PipelineGetter,
  port: number = DEFAULT_CONTROL_PORT
): Promise<ControlServerHandle> {
  const clients = new Set<Client>();
  let clientSeq = 0;

  const send = (res: http.ServerResponse, status: number, body: unknown): void => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Cache-Control': 'no-store',
    });
    res.end(payload);
  };

  // Telemetri olaylarını abonelere yayınla.
  const onTelemetry = (event: unknown): void => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      try {
        client.res.write(line);
      } catch {
        clients.delete(client);
      }
    }
  };
  telemetry.on('event', onTelemetry);

  const readBody = (req: http.IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
        if (raw.length > 1_000_000) raw = raw.slice(0, 1_000_000);
      });
      req.on('end', () => {
        if (!raw.trim()) return resolve({});
        try {
          const parsed = JSON.parse(raw) as unknown;
          resolve(typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {});
        } catch {
          resolve({});
        }
      });
      req.on('error', () => resolve({}));
    });

  /** Mikrofon istatistiklerini periyodik olarak telemetriye yaz. */
  const micTimer = setInterval(() => {
    const p = getPipeline();
    if (!p) {
      telemetry.update('mic', 'idle', 'ajan hazır değil');
      return;
    }
    const stats = p.getAudioStats();
    if (!stats) {
      telemetry.update('mic', 'idle', 'mikrofon kapalı (dinleme yok)');
      return;
    }
    const secs = stats.totalBytes / 32000;
    // `forwardedChunks` KUMULATIF bir sayactir; ilk konusmadan sonra hep > 0
    // kalir ve "ses geliyor mu" sorusunu yanitlamaz. Kullanici "sesim alinmiyor"
    // dediginde panelin dogru cevabi ANLIK seviye olmalidir: `acRms` son
    // yoklama penceresindeki en yuksek DC-cikarilmis RMS'tir.
    const level = stats.acRms ?? 0;
    const threshold = stats.silenceThreshold ?? 0.002;
    const audible = level >= threshold;
    // Sessizlik HATA DEGILDIR: konusma yokken seviye dogal olarak esigin
    // altindadir. `warn` gostermek "sesim alinmiyor" endisesini pekistiriyordu.
    // Ayrim: `idle` = cihaz acik, su an sessiz; `active` = sinyal var.
    const status = !stats.running ? 'error' : audible ? 'active' : 'idle';
    const detail = !stats.running
      ? 'mikrofon akışı durdu — cihaz meşgul olabilir'
      : audible
        ? `dinleniyor: ${stats.device} (seviye ${level.toFixed(4)})`
        : `hazır — sessiz ortam (seviye ${level.toFixed(4)} < eşik ${threshold})`;
    telemetry.update('mic', status, detail, {
      cihaz: stats.device,
      'alınan sn': secs.toFixed(1),
      parça: stats.forwardedChunks,
      atlanan: stats.skippedChunks,
      seviye: level.toFixed(4),
      eşik: String(threshold),
      yeniden: stats.restarts,
    });
  }, 500);

  const buildState = (): Record<string, unknown> => {
    const p = getPipeline();
    const snap = telemetry.snapshot();
    return {
      ok: true,
      pid: process.pid,
      uptime: Math.round(process.uptime()),
      pipeline: p
        ? {
            running: p.isPipelineRunning(),
            sessionId: p.getSessionId(),
            state: p.getState(),
            audio: p.getAudioStats(),
            /*
             * Yazılımsal yankı kapılaması durumu.
             *
             * NEDEN PANELDE: donanımsal AEC bu makinede çalışmıyor, bu yüzden
             * "otomatik barge-in gerçekten korunuyor mu" sorusunun tek kanıtı
             * bu sayaçlardır. `suppressed` artıyorsa yankı ayıklanıyor,
             * `bargeIn` artıyorsa gerçek kullanıcı sesi ayrıştırılıyor.
             */
            echoGuard: p.getEchoGuardStats(),
          }
        : null,
      // TTS çalışma zamanı anahtarının GERÇEK değeri (env + kullanıcı seçimi).
      // Arayüz ve tray bu alanı okuyarak "TTS kapalı" yanlışını göstermez.
      ttsEnabled: p ? p.isTtsEnabled() : null,
      // Ham override: null = env geçerli, true/false = kullanıcı seçti.
      ttsOverride: p ? p.getTtsOverride() : null,
      stages: snap.stages,
      log: snap.log,
      turnMetrics: snap.turnMetrics,
      // Son turun uçtan uca gecikmesi (tur başı → ilk ses). Arayüz panelin
      // en üst satırını bu alanla besler; tur bitince kalıcıdır.
      lastTurnLatency: p?.getState().lastTurnLatency ?? snap.lastTurnLatency,
      /**
       * Arayüzün sohbet panelini besleyen görünen konuşma geçmişi.
       *
       * LLM'e giden `conversationHistory` DEĞİL: sistem/tool mesajları burada
       * yoktur. Bellek şişmemesi için son `CONVERSATION_LIMIT` (50) mesaj
       * tutulur; canlı güncelleme `conversation-update` SSE olayıyla gelir.
       */
      conversation: (p?.getConversation() ??
        snap.conversation.slice(-CONVERSATION_LIMIT)) as ConversationEntry[],
      conversationLimit: CONVERSATION_LIMIT,
      stageOrder: STAGE_ORDER as StageKey[],
      /**
       * Onay bekleyen MCP işlemi (yoksa `null`).
       *
       * Arayüz bu alanı görünce onay diyaloğunu açar; canlı değişim ayrıca
       * `confirmation` SSE olayıyla da gelir. Ajan gerçekten beklemiyorsa
       * asla dolu gösterilmez.
       */
      pendingConfirmation: p?.getPendingConfirmation() ?? snap.pendingConfirmation,
      /**
       * MCP sunucularının canlı durumu (bağlı mı, kaç araç, izinler).
       * Arayüzdeki servis listesi (GMAIL/TAKVİM/…) bu veriden beslenir —
       * sabit "PASİF" etiketi yoktur.
       */
      mcpServers: p?.getMcpServerStatuses() ?? [],
    };
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${CONTROL_HOST}:${port}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      });
      res.end();
      return;
    }

    if (req.method === 'GET' && path === '/health') {
      send(res, 200, { ok: true, pid: process.pid, uptime: Math.round(process.uptime()) });
      return;
    }

    if (req.method === 'GET' && path === '/state') {
      send(res, 200, buildState());
      return;
    }

    if (req.method === 'GET' && path === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      res.write(`event: snapshot\ndata: ${JSON.stringify(buildState())}\n\n`);
      const client: Client = { id: ++clientSeq, res };
      clients.add(client);
      req.on('close', () => {
        clients.delete(client);
      });
      return;
    }

    if (req.method === 'POST' && path === '/listen') {
      void readBody(req).then(async (body) => {
        const p = getPipeline();
        if (!p) {
          send(res, 503, { ok: false, error: 'ajan hazır değil' });
          return;
        }
        const enabled = body.enabled !== false;
        try {
          if (enabled) {
            await p.startListening();
            telemetry.update('mic', 'ready', 'mikrofon açıldı — konuşabilirsiniz');
            telemetry.log('info', 'mic', 'dinleme açıldı');
          } else {
            p.stopListening();
            telemetry.update('mic', 'idle', 'dinleme kapatıldı');
            telemetry.log('info', 'mic', 'dinleme kapatıldı');
          }
          send(res, 200, { ok: true, listening: p.getState().isListening });
        } catch (error) {
          const msg = (error as Error).message;
          telemetry.update('mic', 'error', msg);
          telemetry.log('error', 'mic', msg);
          send(res, 500, { ok: false, error: msg });
        }
      });
      return;
    }

    if (req.method === 'POST' && path === '/ask') {
      void readBody(req).then(async (body) => {
        const p = getPipeline();
        const text = String(body.text ?? '').trim();
        if (!p) {
          send(res, 503, { ok: false, error: 'ajan hazır değil' });
          return;
        }
        if (!text) {
          send(res, 400, { ok: false, error: 'metin boş' });
          return;
        }
        send(res, 202, { ok: true, accepted: true });
        try {
          await p.processText(text);
        } catch (error) {
          const msg = (error as Error).message;
          telemetry.update('llm', 'error', msg);
          telemetry.log('error', 'llm', msg);
        }
      });
      return;
    }

    if (req.method === 'POST' && path === '/inject') {
      // Teşhis: dosyadan/istekten gelen PCM'i mikrofon akışı gibi boru hattına
      // verir. Gerçek zamanlı tempoda (100 ms'lik parçalar) beslenir ki VAD'ın
      // sessizlik ölçümü ve tur algılama gerçek akıştaki gibi çalışsın.
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const pcm = Buffer.concat(chunks);
        const p = getPipeline();
        if (!p) {
          send(res, 503, { ok: false, error: 'ajan hazır değil' });
          return;
        }
        if (pcm.length < 3200) {
          send(res, 400, { ok: false, error: 'PCM çok kısa (en az 100 ms gerekli)' });
          return;
        }
        telemetry.log('info', 'mic', `enjekte edilen ses: ${(pcm.length / 32000).toFixed(1)} sn`);
        send(res, 202, { ok: true, seconds: Number((pcm.length / 32000).toFixed(2)) });
        const STEP = 3200; // 100 ms
        // Sondaki sessizlik: gerçek mikrofonda konuşma bittikten sonra sessiz
        // parçalar gelmeye devam eder ve VAD "konuşma bitti" kararını verir.
        // Enjeksiyonda bu yoksa segment hiç kapanmaz — bu yüzden 1.5 sn
        // sıfır PCM eklenir.
        const SILENCE_CHUNKS = 15;
        let silenceLeft = SILENCE_CHUNKS;
        let off = 0;
        const timer = setInterval(() => {
          if (off < pcm.length) {
            const slice = pcm.subarray(off, Math.min(off + STEP, pcm.length));
            off += STEP;
            void p.processAudio(Buffer.from(slice));
            return;
          }
          if (silenceLeft <= 0) {
            clearInterval(timer);
            return;
          }
          silenceLeft -= 1;
          void p.processAudio(Buffer.alloc(STEP));
        }, 100);
      });
      return;
    }

    if (req.method === 'POST' && path === '/tts') {
      void readBody(req).then((body) => {
        const p = getPipeline();
        if (!p) {
          send(res, 503, { ok: false, error: 'ajan hazır değil' });
          return;
        }
        // `enabled` yoksa/null ise env'e geri dön (kullanıcı "otomatik" seçti).
        const enabled = typeof body.enabled === 'boolean' ? body.enabled : null;
        const aktif = p.setTtsEnabled(enabled);
        send(res, 200, { ok: true, enabled: aktif, override: enabled });
      });
      return;
    }

    if (req.method === 'POST' && path === '/confirm') {
      void readBody(req).then(async (body) => {
        const p = getPipeline();
        if (!p) {
          send(res, 503, { ok: false, error: 'ajan hazır değil' });
          return;
        }
        const confirmed = body.confirmed === true;

        /**
         * YARIŞ DURUMU (canlı ölçümde bulundu):
         *
         * `requestVoiceConfirmation()` onay kaydını TTS'ten ÖNCE yayınlar
         * (`expiresAt: null`) ama `pendingConfirmation` promise'ini seslendirme
         * BİTTİKTEN sonra kurar. Arayüz diyaloğu erken açtığı için kullanıcı
         * "Onayla"ya hemen basarsa istek `applied:false` ile sessizce
         * kayboluyordu.
         *
         * Çözüm: onay kaydı duruyorsa kısa süre (en fazla 5 sn) bekle ve
         * yeniden dene. Bekleyen onay hiç yoksa hemen `applied:false` dön.
         */
        const waitUntil = Date.now() + 5000;
        let applied = p.confirmPendingAction(confirmed);
        while (!applied && p.getPendingConfirmation() && Date.now() < waitUntil) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          applied = p.confirmPendingAction(confirmed);
        }

        telemetry.log(
          'info',
          'mcp',
          applied
            ? confirmed
              ? 'onay verildi'
              : 'onay reddedildi'
            : 'onay iletilemedi (bekleyen işlem yok)'
        );
        send(res, 200, { ok: true, applied });
      });
      return;
    }

    /**
     * Ayarlar ekranının model listeleri.
     *
     * Neden `/state` içinde değil: LLM listesi için yerel sunucuya HTTP
     * isteği gerekir (~2,5 sn zaman aşımı) ve `/state` her arayüz açılışında
     * çağrılır. Bu yüzden katalog AYRI ve isteğe bağlı bir uç noktadır;
     * yalnızca Ayarlar paneli açıldığında çekilir.
     */
    if (req.method === 'GET' && path === '/models') {
      const p = getPipeline();
      if (!p) {
        send(res, 503, { ok: false, error: 'ajan hazır değil' });
        return;
      }
      void p
        .getModelCatalog()
        .then((catalog) => send(res, 200, { ok: true, ...catalog }))
        .catch((error: Error) => {
          telemetry.log('error', 'agent', `model listesi alınamadı: ${error.message}`);
          send(res, 500, { ok: false, error: error.message });
        });
      return;
    }

    /**
     * Model değiştirme: `POST /models/select { kind, id }`
     *
     * `kind`: `stt` | `tts` | `llm`. Yanıt `{ ok, current, reason?, slow? }`.
     * Değişim başarısızsa motor ESKİ modeliyle çalışmaya devam eder.
     */
    if (req.method === 'POST' && path === '/models/select') {
      void readBody(req).then(async (body) => {
        const p = getPipeline();
        if (!p) {
          send(res, 503, { ok: false, error: 'ajan hazır değil' });
          return;
        }

        const kind = String(body.kind ?? '').trim() as 'stt' | 'tts' | 'llm';
        const id = String(body.id ?? '').trim();
        if (kind !== 'stt' && kind !== 'tts' && kind !== 'llm') {
          send(res, 400, { ok: false, error: 'kind stt|tts|llm olmalı' });
          return;
        }
        if (!id) {
          send(res, 400, { ok: false, error: 'id boş olamaz' });
          return;
        }

        const result = await p.selectModel(kind, id);

        /**
         * Kalıcılık: seçim `~/.config/diji/env` dosyasına yazılır ve ajan
         * yeniden başladığında da geçerli olur. Yazma başarısız olursa model
         * yine değişmiştir (bu süreçte geçerli) — arayüz `persisted:false`
         * görüp kullanıcıyı uyarır; bu yüzden yanıt `ok:true` kalır.
         */
        const persistHint = result.persisted
          ? 'Seçim kalıcı kaydedildi (~/.config/diji/env)'
          : result.persistError
            ? `Kalıcı kaydedilemedi: ${result.persistError}`
            : 'Seçim yalnızca bu oturum için geçerli';

        send(res, result.ok ? 200 : 409, { ...result, persistHint });
      });
      return;
    }

    /**
     * LLM sağlayıcısı değiştirme: `POST /llm/provider { provider, apiKey? }`
     *
     * `provider`: `local` | `deepseek`. Uzak sağlayıcı için `apiKey` ZORUNLUDUR
     * (daha önce kaydedilmişse istekte göndermek gerekmez).
     *
     * Neden `/models/select`'ten ayrı: sağlayıcı değişimi `baseUrl` + `apiKey`
     * + `model` alanlarını BİRLİKTE değiştirir. Tek bir model listesine
     * sıkıştırmak, kullanıcının yerel sunucuya `deepseek-flash` göndermesi
     * gibi sessiz hatalara yol açardı.
     *
     * Yanıt: `{ ok, current?, reason?, apiKeyRequired?, baseUrl?, persisted? }`.
     * `apiKeyRequired: true` → arayüz anahtar alanını açar ve geçiş YAPILMAZ.
     * Anahtar YALNIZCA `~/.config/diji/secrets/<provider>.key` dosyasına
     * yazılır (0600); `~/.config/diji/env` içine asla yazılmaz.
     */
    if (req.method === 'POST' && path === '/llm/provider') {
      void readBody(req).then(async (body) => {
        const p = getPipeline();
        if (!p) {
          send(res, 503, { ok: false, error: 'ajan hazır değil' });
          return;
        }

        const provider = String(body.provider ?? '').trim();
        if (provider !== 'local' && provider !== 'deepseek') {
          send(res, 400, { ok: false, error: 'provider local|deepseek olmalı' });
          return;
        }

        // Boş dize "anahtar verilmedi" demektir; kayıtlı anahtar kullanılır.
        const apiKey = typeof body.apiKey === 'string' ? body.apiKey : undefined;

        const result = await p.selectLlmProvider(provider, apiKey);

        const persistHint = result.ok
          ? result.persisted
            ? 'Sağlayıcı kalıcı kaydedildi (~/.config/diji/env)'
            : result.persistError
              ? `Kalıcı kaydedilemedi: ${result.persistError}`
              : 'Sağlayıcı yalnızca bu oturum için geçerli'
          : undefined;

        // 400 = eksik/geçersiz girdi (anahtar yok), 409 = doğrulama başarısız.
        const status = result.ok ? 200 : result.apiKeyRequired ? 400 : 409;
        send(res, status, { ...result, ...(persistHint ? { persistHint } : {}) });
      });
      return;
    }

    if (req.method === 'POST' && path === '/bargein') {
      const p = getPipeline();
      if (p) p.handleBargeIn();
      send(res, 200, { ok: true });
      return;
    }

    send(res, 404, { ok: false, error: `bilinmeyen uç nokta: ${path}` });
  });

  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      clearInterval(micTimer);
      telemetry.off('event', onTelemetry);
      reject(error);
    });
    server.listen(port, CONTROL_HOST, () => {
      logInfo('Kontrol sunucusu hazir', {
        url: `http://${CONTROL_HOST}:${port}`,
        endpoints: ['/health', '/state', '/events', '/listen', '/ask', '/tts', '/confirm', '/bargein'],
      });
      telemetry.update('agent', 'ready', `kontrol sunucusu :${port}`, {
        pid: process.pid,
        port,
      });

      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(micTimer);
            telemetry.off('event', onTelemetry);
            for (const client of clients) {
              try {
                client.res.end();
              } catch {
                /* yoksay */
              }
            }
            clients.clear();
            server.close(() => done());
          }),
      });
    }).on('error', (error: Error) => {
      logError('Kontrol sunucusu baslatilamadi', error, { port });
    });
  });
}
