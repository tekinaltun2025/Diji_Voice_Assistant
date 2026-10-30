import { logDebug, logError, logInfo, logWarn, TTSConfig } from '@diji/shared';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * sherpa-onnx-node ceviri tipleri (paket .d.ts saglamaz).
 */
interface SherpaGeneratedAudio {
  samples: Float32Array;
  sampleRate: number;
}

interface SherpaOfflineTts {
  sampleRate: number;
  numSpeakers?: number;
  generate(obj: { text: string; sid?: number; speed?: number }): SherpaGeneratedAudio;
  free?(): void;
}

interface SherpaModule {
  OfflineTts: new (config: unknown) => SherpaOfflineTts;
}

let sherpa: SherpaModule | null = null;

function loadSherpa(): SherpaModule | null {
  if (sherpa) return sherpa;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sherpa = require('sherpa-onnx-node') as SherpaModule;
    return sherpa;
  } catch (error) {
    logError(
      'sherpa-onnx-node yuklenemedi. "npm install sherpa-onnx-node" calistirin.',
      error as Error
    );
    return null;
  }
}

export interface TTSResult {
  audioBuffer: Buffer;
  sampleRate: number;
  duration: number;
  text: string;
}

export interface TTSStreamEvent {
  type: 'audio' | 'complete' | 'error';
  audioBuffer?: Buffer;
  text?: string;
  /**
   * Bu parcadaki PCM'in ornekleme frekansi (Hz).
   * Hoparlor katmani bu degeri kullanmalidir; sabit 16 kHz varsaymak
   * sesin hizli/tiz calinmasina yol acar (ornek: VITS 22.05 kHz uretir).
   */
  sampleRate?: number;
  timestamp: Date;
}

export interface TTSEngineOptions {
  /** VITS model dizini veya onnx dosya yolu. */
  modelPath?: string;
  /** Cok konusmacili modellerde konusmaci kimligi. */
  speakerId?: number;
}

const DEFAULT_MODELS_DIR =
  process.env.DIJI_MODELS_DIR || path.join(os.homedir(), '.diji', 'models');

/** Pipeline'in bekledigi varsayilan ornekleme frekansi. */
const DEFAULT_OUTPUT_SAMPLE_RATE = 16000;

/** Bilinen VITS TTS model dizin adlari. */
const KNOWN_TTS_DIRS = [
  'vits-piper-tr_TR-fettah-medium',
  'vits-piper-tr_TR-fettah-low',
  'vits-melo-tts-tr',
  'vits-tr',
];

/** Drifting TTS koprusunun cerceve basligi: 4 bayt ornekleme hizi + 4 bayt uzunluk. */
const DRIFTING_FRAME_HEADER_BYTES = 8;

interface DriftingFrame {
  sampleRate: number;
  payload: Buffer;
}

/**
 * Python `drifting-tts` (Vyvo/drifting-tts-tr) paketine kopru.
 *
 * Neden alt surec: model PyTorch agirliklariyla Python'da calisir ve
 * yuklemesi ~60-70 saniye surer. Her sentez icin yeni surec baslatmak
 * kabul edilemez; bu yuzden surec omru boyunca ayakta tutulur ve istekler
 * sirayla islenir.
 *
 * Protokol: stdin'e satir basina JSON, stdout'tan ikili cerceve
 * (bkz. scripts/drifting_tts_bridge.py).
 */
class DriftingBridge {
  private child: ChildProcess | null = null;
  private readBuffer: Buffer = Buffer.alloc(0);
  private queue: Array<{
    resolve: (frame: DriftingFrame) => void;
    reject: (error: Error) => void;
  }> = [];
  private nextId = 1;
  private readonly pythonPath: string;
  private readonly bridgePath: string;

  constructor(options: { pythonPath?: string; bridgePath?: string }) {
    this.pythonPath = options.pythonPath || process.env.DIJI_TTS_PYTHON || 'python3';
    this.bridgePath = DriftingBridge.resolveBridgePath(options.bridgePath);
  }

  /**
   * Kopru betigini bul.
   *
   * Acikca verilen bir yol (yapilandirma veya DIJI_TTS_BRIDGE) VARSA ve
   * dosya yoksa sessizce baska bir adaya DUSMEZ — acik hata firlatilir.
   * Aksi halde kullanici yanlis yapilandirmayi fark edemez ve yanlislikla
   * baska bir betik calisir.
   */
  private static resolveBridgePath(explicit?: string): string {
    const configured = explicit || process.env.DIJI_TTS_BRIDGE;
    if (configured) {
      if (!fs.existsSync(configured)) {
        throw new Error(`Yapilandirilmis Drifting TTS kopru betigi bulunamadi: ${configured}`);
      }
      return configured;
    }

    const candidates = [
      // agent/dist/tts.js -> <kok>/scripts/drifting_tts_bridge.py
      path.resolve(__dirname, '..', '..', 'scripts', 'drifting_tts_bridge.py'),
      // agent/src/tts.ts (ts-node) -> <kok>/scripts/...
      path.resolve(__dirname, '..', '..', '..', 'scripts', 'drifting_tts_bridge.py'),
      path.resolve(process.cwd(), 'scripts', 'drifting_tts_bridge.py'),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return candidates[0];
  }

  /** Alt sureci baslatir. Zaten calisiyorsa hicbir sey yapmaz. */
  async start(): Promise<void> {
    if (this.child && this.child.exitCode === null) return;

    if (!fs.existsSync(this.bridgePath)) {
      throw new Error(`Drifting TTS kopru betigi bulunamadi: ${this.bridgePath}`);
    }

    const child = spawn(this.pythonPath, ['-u', this.bridgePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    this.child = child;
    this.readBuffer = Buffer.alloc(0);

    child.stdout?.on('data', (data: Buffer) => this.onStdout(data));

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (!text) return;
      // Torch/ROCm stderr'i cok gurultulu; yalnizca debug seviyesinde kirp.
      logDebug('Drifting TTS kopru stderr', { data: text.slice(0, 300) });
    });

    child.on('error', (error: Error) => {
      this.child = null;
      this.failAll(new Error(`Drifting TTS kopru sureci baslatilamadi: ${error.message}`));
    });

    child.on('close', (code: number | null) => {
      this.child = null;
      this.failAll(new Error(`Drifting TTS kopru sureci kapandi (code=${code})`));
    });

    logInfo('Drifting TTS kopru sureci baslatildi', {
      python: this.pythonPath,
      bridge: this.bridgePath,
      pid: child.pid,
    });
  }

  /** Tek bir metni sentezler ve ham PCM dondurur. */
  async synthesize(
    text: string,
    speed: number,
    sampleRate: number
  ): Promise<{ audioBuffer: Buffer; sampleRate: number }> {
    const frame = await this.requestFrame({ text, speed, sampleRate });
    return { audioBuffer: frame.payload, sampleRate: frame.sampleRate };
  }

  private requestFrame(payload: Record<string, unknown>): Promise<DriftingFrame> {
    const child = this.child;
    if (!child || !child.stdin || child.stdin.destroyed) {
      return Promise.reject(new Error('Drifting TTS kopru sureci calismiyor'));
    }

    const id = this.nextId++;

    return new Promise<DriftingFrame>((resolve, reject) => {
      this.queue.push({ resolve, reject });
      try {
        child.stdin?.write(`${JSON.stringify({ ...payload, id })}\n`);
      } catch (error) {
        this.queue.pop();
        reject(error as Error);
      }
    });
  }

  /** stdout'tan gelen baytlari cercevelere ayirir. */
  private onStdout(chunk: Buffer): void {
    this.readBuffer =
      this.readBuffer.length === 0 ? chunk : Buffer.concat([this.readBuffer, chunk]);

    while (this.readBuffer.length >= DRIFTING_FRAME_HEADER_BYTES) {
      const sampleRate = this.readBuffer.readUInt32BE(0);
      const length = this.readBuffer.readUInt32BE(4);

      // Bozuk uzunluk: protokol koptu, tamponu sifirla.
      if (length > 64 * 1024 * 1024) {
        logError('Drifting TTS kopru: gecersiz cerceve uzunlugu', undefined, {
          length,
          buffered: this.readBuffer.length,
        });
        this.readBuffer = Buffer.alloc(0);
        this.failAll(new Error('Drifting TTS kopru protokol hatasi'));
        return;
      }

      if (this.readBuffer.length < DRIFTING_FRAME_HEADER_BYTES + length) break;

      const payload = Buffer.from(
        this.readBuffer.subarray(DRIFTING_FRAME_HEADER_BYTES, DRIFTING_FRAME_HEADER_BYTES + length)
      );
      this.readBuffer = this.readBuffer.subarray(DRIFTING_FRAME_HEADER_BYTES + length);

      const pending = this.queue.shift();
      if (!pending) {
        logWarn('Drifting TTS kopru: beklenmeyen cerceve', {
          sampleRate,
          bytes: payload.length,
        });
        continue;
      }

      // sampleRate === 0 -> Python tarafi hata metni gonderdi.
      if (sampleRate === 0) {
        pending.reject(new Error(payload.toString('utf8') || 'Drifting TTS sentez hatasi'));
      } else {
        pending.resolve({ sampleRate, payload });
      }
    }
  }

  private failAll(error: Error): void {
    const pending = this.queue;
    this.queue = [];
    for (const item of pending) {
      item.reject(error);
    }
  }

  async dispose(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.failAll(new Error('Drifting TTS kopru kapatildi'));

    if (!child) return;

    try {
      child.stdin?.write(`${JSON.stringify({ op: 'shutdown' })}\n`);
      child.stdin?.end();
    } catch {
      // surec zaten kapanmis olabilir
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // yoksay
        }
        resolve();
      }, 2000);

      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/**
 * Yerel Turkce seslendirme motoru.
 *
 * Iki arka uc destekler:
 *   - `drifting-tts` : Vyvo/drifting-tts-tr, tek adimli Turkce TTS (onerilen;
 *                     89.3M params, Freya-TR-Eval WER %1,33). Python kopru
 *                      alt sureci uzerinden calisir. Baslatilamazsa
 *                      otomatik olarak `sherpa-vits`'e duser.
 *   - `sherpa-vits`  : Yerel Piper/VITS ONNX modeli (Node, sherpa-onnx-node).
 *
 * Model dosyalari yoksa baslatma hatasi verir — sessizce bos ses
 * dondurmez. Bu sayede "asistan konusuyor ama ses yok" durumu
 * teshis edilebilir kalir.
 */
export class TTSEngine {
  private config: TTSConfig;
  private isInitialized = false;
  private tts: SherpaOfflineTts | null = null;
  private drifting: DriftingBridge | null = null;
  private activeProvider: 'sherpa-vits' | 'drifting-tts' = 'sherpa-vits';
  /**
   * ÇÖZÜMLENMİŞ model kimliği.
   *
   * Neden ayrı alan: `config.model` kullanıcının NİYETİdir (ör.
   * `Vyvo/drifting-tts-tr`). Sağlayıcı başlatılamayıp yedeğe düşüldüğünde
   * gerçekte çalışan model başkadır. Ayarlar ekranı "seçili" işaretini buna
   * göre koyar; aksi halde arayüz çalışmayan bir sağlayıcıyı seçili gösterir
   * (canlı doğrulamada yakalandı: drifting-tts başlatılamadı, sherpa-vits
   * çalışıyor ama panel drifting-tts yazıyordu).
   */
  private resolvedModelName = '';
  private sampleRate = DEFAULT_OUTPUT_SAMPLE_RATE;
  private modelPath: string | null;
  private speakerId: number;
  private isSpeaking = false;
  /** Barge-in / durdurma istegi — akisli sentez dongusunu keser. */
  private stopRequested = false;

  constructor(config: TTSConfig, options: TTSEngineOptions = {}) {
    this.config = config;
    this.modelPath = options.modelPath || null;
    this.speakerId = options.speakerId ?? 0;
    this.sampleRate = config.sampleRate ?? DEFAULT_OUTPUT_SAMPLE_RATE;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    logInfo('TTS motoru baslatiliyor', {
      provider: this.config.provider,
      model: this.config.model,
      voice: this.config.voice,
      speed: this.config.speed,
      sampleRate: this.config.sampleRate ?? DEFAULT_OUTPUT_SAMPLE_RATE,
    });

    if (this.config.provider === 'drifting-tts') {
      const ready = await this.initializeDrifting();
      if (ready) {
        this.isInitialized = true;
        return;
      }
      logWarn(
        'Drifting TTS baslatilamadi; sherpa-vits motoruna dusuluyor. ' +
          'Kurulum: pip install "drifting-tts[bigvgan] @ git+https://github.com/kadirnar/drifting-tts" ' +
          '(veya DIJI_TTS_PROVIDER=sherpa-vits ile sabitleyin)'
      );
    }

    await this.initializeSherpa();
    this.isInitialized = true;
  }

  /**
   * Drifting TTS koprusunu baslatir ve kisa bir sentezle dogrular.
   *
   * Model yuklemesi ~60-70 saniye surdugu icin isinma sentezi burada bir
   * kez yapilir; boylece ilk gercek kullanici cevabi beklemez.
   */
  private async initializeDrifting(): Promise<boolean> {
    let bridge: DriftingBridge;

    try {
      bridge = new DriftingBridge({
        pythonPath: this.config.pythonPath,
        bridgePath: this.config.bridgePath,
      });
    } catch (error) {
      logError('Drifting TTS koprusu hazirlanamadi', error as Error, {
        bridgePath: this.config.bridgePath,
        pythonPath: this.config.pythonPath || 'python3',
      });
      return false;
    }

    try {
      await bridge.start();

      // Isinma + dogrulama: kopru gercekten PCM uretiyor mu?
      const probe = await bridge.synthesize(
        'Merhaba.',
        this.config.speed ?? 1.0,
        this.config.sampleRate ?? DEFAULT_OUTPUT_SAMPLE_RATE
      );

      if (probe.audioBuffer.length === 0) {
        throw new Error('Drifting TTS bos ses uretti');
      }

      this.drifting = bridge;
      this.activeProvider = 'drifting-tts';
      this.resolvedModelName = 'drifting-tts';
      this.sampleRate = probe.sampleRate;

      logInfo('TTS motoru hazir (drifting-tts)', {
        sampleRate: this.sampleRate,
        probeBytes: probe.audioBuffer.length,
      });
      return true;
    } catch (error) {
      logError('Drifting TTS baslatilamadi', error as Error, {
        bridgePath: this.config.bridgePath,
        pythonPath: this.config.pythonPath || 'python3',
      });
      await bridge.dispose().catch(() => undefined);
      return false;
    }
  }

  /** sherpa-onnx VITS motorunu baslatir (fallback). */
  private async initializeSherpa(): Promise<void> {
    const sherpaModule = loadSherpa();
    if (!sherpaModule) {
      throw new Error(
        'TTS baslatilamadi: sherpa-onnx-node bulunamadi. ' +
          '"npm install sherpa-onnx-node" calistirin.'
      );
    }

    const modelFiles = this.resolveModelFiles();
    if (!modelFiles) {
      throw new Error(
        'TTS baslatilamadi: VITS model dosyalari bulunamadi.\n' +
          `Aranan dizin: ${DEFAULT_MODELS_DIR}\n` +
          'Modeli indirmek icin: ./scripts/download-models.sh tts'
      );
    }

    try {
      this.tts = new sherpaModule.OfflineTts({
        model: {
          vits: {
            model: modelFiles.model,
            tokens: modelFiles.tokens,
            ...(modelFiles.lexicon ? { lexicon: modelFiles.lexicon } : {}),
            ...(modelFiles.dataDir ? { dataDir: modelFiles.dataDir } : {}),
          },
          numThreads: 2,
          provider: 'cpu',
          debug: 0,
        },
        maxNumSentences: 1,
      });

      this.sampleRate = this.tts.sampleRate || 22050;
      this.activeProvider = 'sherpa-vits';
      // Dizin adı, seçim listesindeki kimlikle BİREBİR aynı olmalı; aksi
      // halde arayüz "seçili" işaretini koyamaz.
      this.resolvedModelName = path.basename(path.dirname(modelFiles.model));

      logInfo('TTS motoru hazir (sherpa-vits)', {
        model: path.basename(modelFiles.model),
        sampleRate: this.sampleRate,
        numSpeakers: this.tts.numSpeakers ?? 1,
      });
    } catch (error) {
      logError('TTS motoru baslatilamadi', error as Error, { modelFiles });
      throw error;
    }
  }

  private resolveModelFiles(): {
    model: string;
    tokens: string;
    lexicon?: string;
    dataDir?: string;
  } | null {
    const candidates: string[] = [];

    if (this.modelPath) {
      if (fs.existsSync(this.modelPath)) {
        const stat = fs.statSync(this.modelPath);
        candidates.push(stat.isDirectory() ? this.modelPath : path.dirname(this.modelPath));
      }
    }

    for (const name of KNOWN_TTS_DIRS) {
      const dir = path.join(DEFAULT_MODELS_DIR, name);
      if (fs.existsSync(dir)) candidates.push(dir);
    }

    // Bilinmeyen ama vits-* ile baslayan dizinleri de dene
    if (fs.existsSync(DEFAULT_MODELS_DIR)) {
      for (const entry of fs.readdirSync(DEFAULT_MODELS_DIR)) {
        if (entry.startsWith('vits-')) {
          const dir = path.join(DEFAULT_MODELS_DIR, entry);
          if (fs.statSync(dir).isDirectory() && !candidates.includes(dir)) {
            candidates.push(dir);
          }
        }
      }
    }

    for (const dir of candidates) {
      const modelFile = this.findFirst(dir, /\.onnx$/);
      const tokens = path.join(dir, 'tokens.txt');
      if (modelFile && fs.existsSync(tokens)) {
        const lexicon = path.join(dir, 'lexicon.txt');
        const dataDir = path.join(dir, 'espeak-ng-data');
        return {
          model: modelFile,
          tokens,
          ...(fs.existsSync(lexicon) ? { lexicon } : {}),
          ...(fs.existsSync(dataDir) ? { dataDir } : {}),
        };
      }
    }

    return null;
  }

  private findFirst(dir: string, pattern: RegExp): string | null {
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (pattern.test(entry)) return path.join(dir, entry);
      }
    } catch {
      // okunamayan dizin
    }
    return null;
  }

  /**
   * Metni konusmaya cevirir. Donen buffer 16-bit mono PCM'dir.
   */
  async synthesize(text: string): Promise<TTSResult> {
    if (!this.isInitialized) {
      throw new Error('TTS motoru baslatilmamis');
    }

    const cleanText = text.trim();
    if (!cleanText) {
      return {
        audioBuffer: Buffer.alloc(0),
        sampleRate: this.sampleRate,
        duration: 0,
        text: '',
      };
    }

    const startTime = Date.now();
    this.isSpeaking = true;

    try {
      if (this.activeProvider === 'drifting-tts') {
        const bridge = this.drifting;
        if (!bridge) throw new Error('Drifting TTS kopru hazir degil');

        const result = await bridge.synthesize(
          cleanText,
          this.config.speed ?? 1.0,
          this.sampleRate
        );
        const sampleRate = result.sampleRate || this.sampleRate;
        const samples = result.audioBuffer.length / 2;
        const durationMs = Math.round((samples / sampleRate) * 1000);

        logDebug('Seslendirme tamamlandi (drifting-tts)', {
          textLength: cleanText.length,
          durationMs,
          elapsedMs: Date.now() - startTime,
          sampleRate,
        });

        return {
          audioBuffer: result.audioBuffer,
          sampleRate,
          duration: durationMs,
          text: cleanText,
        };
      }

      if (!this.tts) throw new Error('sherpa-vits motoru hazir degil');

      const audio = this.tts.generate({
        text: cleanText,
        sid: this.speakerId,
        speed: this.config.speed ?? 1.0,
      });

      const audioBuffer = this.float32ToPcm16(audio.samples);
      const sampleRate = audio.sampleRate || this.sampleRate;
      const durationMs = Math.round((audio.samples.length / sampleRate) * 1000);

      logDebug('Seslendirme tamamlandi (sherpa-vits)', {
        textLength: cleanText.length,
        durationMs,
        elapsedMs: Date.now() - startTime,
        sampleRate,
      });

      return {
        audioBuffer,
        sampleRate,
        duration: durationMs,
        text: cleanText,
      };
    } catch (error) {
      logError('Seslendirme hatasi', error as Error, {
        textLength: cleanText.length,
        provider: this.activeProvider,
      });
      throw error;
    } finally {
      this.isSpeaking = false;
    }
  }

  /**
   * Uzun metinleri cumle sinirlarinda parcalayarak artimli ses uretir.
   * Canli gorusmede ilk sesin gecikmesini azaltir.
   */
  async *synthesizeStream(text: string): AsyncGenerator<TTSStreamEvent, void, unknown> {
    if (!this.isInitialized) {
      throw new Error('TTS motoru baslatilmamis');
    }

    const sentences = this.splitIntoSentences(text);

    this.stopRequested = false;
    this.isSpeaking = true;

    // Tek bir cumle parcasinin sentezlenememesi TUM yaniti sessizlestirmemeli:
    // ornek: yanit "— ... Merhaba." ile basliyorsa ilk parca yalnizca
    // noktalama olabilir ve motor bos ses dondurur. Boyle parcalar atlanir,
    // diger cumleler seslendirilmeye devam eder.
    let producedChunks = 0;
    let lastError: string | null = null;

    for (const sentence of sentences) {
      // Barge-in: aradaki cumleleri sentezlemeden cik.
      if (this.stopRequested) {
        this.isSpeaking = false;
        logInfo('TTS akisi durduruldu (barge-in)');
        return;
      }

      try {
        const result = await this.synthesize(sentence);

        // Sentez suresi boyunca barge-in geldiyse bu parcayi at.
        if (this.stopRequested) {
          this.isSpeaking = false;
          logInfo('TTS akisi durduruldu (barge-in, sentez sonrasi)');
          return;
        }

        if (result.audioBuffer.length > 0) {
          producedChunks += 1;
          yield {
            type: 'audio',
            audioBuffer: result.audioBuffer,
            text: sentence,
            sampleRate: result.sampleRate,
            timestamp: new Date(),
          };
        } else {
          logWarn('TTS parcasi bos ses uretti — atlandi', {
            textLength: sentence.length,
            provider: this.activeProvider,
          });
        }
      } catch (error) {
        // Parca hatasi akisi kesmez; diger cumleler denenir. Hicbir parca
        // uretilemezse asagida tek bir hata olayi bildirilir.
        lastError = (error as Error).message;
        logWarn('TTS parcasi sentezlenemedi — sonraki cumleye geciliyor', {
          textLength: sentence.length,
          provider: this.activeProvider,
          error: lastError,
        });
        continue;
      }
    }

    if (producedChunks === 0 && lastError) {
      this.isSpeaking = false;
      yield { type: 'error', text: lastError, timestamp: new Date() };
      return;
    }

    this.isSpeaking = false;
    yield { type: 'complete', text, timestamp: new Date() };
  }

  /**
   * Geriye donuk uyumluluk: pipeline `speakStream()` adini kullaniyor.
   */
  speakStream(text: string): AsyncGenerator<TTSStreamEvent, void, unknown> {
    return this.synthesizeStream(text);
  }

  /**
   * Devam eden sentezi durdurur (barge-in).
   * Akisli dongu bir sonraki cumle basinda cikar.
   */
  stop(): void {
    this.stopRequested = true;
    this.isSpeaking = false;
    logInfo('TTS durdurma istegi alindi');
  }

  /** Turkce noktalama isaretlerine gore cumlelere ayirir. */
  private splitIntoSentences(text: string): string[] {
    const parts = text
      .split(/(?<=[.!?…])\s+/)
      .map((s) => s.trim())
      // Yalnizca noktalama/isaret iceren parcalar (or. "—", "...", "✨")
      // seslendirilemez: motor bunlara bos ses dondurur. Harf veya rakam
      // icermeyen parcalari bastan ele.
      .filter((s) => s.length > 0 && /[\p{L}\p{N}]/u.test(s));

    return parts.length > 0 ? parts : [text];
  }

  /** Float32 (-1..1) -> 16-bit little-endian PCM */
  private float32ToPcm16(samples: Float32Array): Buffer {
    const buffer = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
      const clamped = Math.max(-1, Math.min(1, samples[i]));
      const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      buffer.writeInt16LE(Math.round(value), i * 2);
    }
    return buffer;
  }

  getSampleRate(): number {
    return this.sampleRate;
  }

  /** Aktif arka ucun adi (teshis icin). */
  getProvider(): 'sherpa-vits' | 'drifting-tts' {
    return this.activeProvider;
  }

  /**
   * GERÇEKTEN çalışan model kimliği (Ayarlar ekranındaki seçim listesiyle
   * birebir eşleşir: sağlayıcı adı veya VITS dizin adı).
   */
  getModelName(): string {
    return this.resolvedModelName;
  }

  getIsSpeaking(): boolean {
    return this.isSpeaking;
  }

  async dispose(): Promise<void> {
    if (this.drifting) {
      const bridge = this.drifting;
      this.drifting = null;
      try {
        await bridge.dispose();
      } catch (error) {
        logWarn('Drifting TTS koprusu kapatilirken hata', {
          error: (error as Error).message,
        });
      }
    }

    if (this.tts) {
      try {
        this.tts.free?.();
      } catch (error) {
        logWarn('TTS modeli kapatilirken hata', {
          error: (error as Error).message,
        });
      }
      this.tts = null;
    }

    this.isInitialized = false;
    this.isSpeaking = false;
    logInfo('TTS motoru kapatildi');
  }
}

export const createTTSEngine = (config: TTSConfig, options?: TTSEngineOptions): TTSEngine => {
  return new TTSEngine(config, options);
};
