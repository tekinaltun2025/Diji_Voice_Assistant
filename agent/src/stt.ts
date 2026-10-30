import { logDebug, logError, logInfo, logWarn, STTConfig } from '@diji/shared';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { preprocessAudio, type PreprocessResult } from './audio-preprocess';
import { postprocessTranscript } from './stt-postprocess';

/**
 * sherpa-onnx-node ceviri tipleri.
 * Paket kendi .d.ts dosyalarini saglamadigi icin yerel olarak tanimlanir.
 */
interface SherpaWaveform {
  samples: Float32Array;
  sampleRate: number;
}

interface SherpaStream {
  acceptWaveform(obj: { sampleRate: number; samples: Float32Array }): void;
}

interface SherpaRecognitionResult {
  text?: string;
  tokens?: string[];
  lang?: string;
  emotion?: string;
  event?: string;
  timestamps?: number[];
}

interface SherpaOfflineRecognizer {
  createStream(): SherpaStream;
  decode(stream: SherpaStream): void;
  decodeAsync(stream: SherpaStream): Promise<void>;
  getResult(stream: SherpaStream): SherpaRecognitionResult;
  free?(): void;
}

interface SherpaModule {
  OfflineRecognizer: new (config: unknown) => SherpaOfflineRecognizer;
  readWave?: (filename: string) => SherpaWaveform;
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

export interface STTResult {
  /** Son isleme gecmis (duzeltilmis) metin. */
  text: string;
  /** Modelin urettigi ham metin (teshis icin; `text` ile ayni olabilir). */
  rawText: string;
  isFinal: boolean;
  language: string;
  confidence: number;
  /** Toplam STT suresi (transcribe cagrisinin tamami, ms). */
  duration: number;
  /** Ses on isleme suresi (ms). */
  preprocessMs: number;
  /** Transkript son isleme suresi (ms). */
  postprocessMs: number;
  /** Yapilan transkript duzeltmesi sayisi. */
  fixes: number;
  /** Kullanilan model kimligi (or. "whisper-medium"). */
  model: string;
  /** On isleme sonrasi ses bos kaldi (tamamen sessiz segment). */
  silent: boolean;
  /** Ses on isleme teshis bilgisi (kazanc, kirpma). */
  preprocess?: {
    inputMs: number;
    outputMs: number;
    gainDb: number;
    trimmedMs: number;
    inputRms: number;
    outputRms: number;
  };
}

export interface STTStreamEvent {
  type: 'partial' | 'final' | 'error';
  text: string;
  isFinal: boolean;
  timestamp: Date;
}

export interface STTEngineOptions {
  /** Model dizini. Verilmezse DIJI_MODELS_DIR veya ~/.diji/models kullanilir. */
  modelDir?: string;
  /** Whisper model dosya oneki (orn. "small") — tek model zorlamak icin. */
  modelPrefix?: string;
  /** Diskte aranacak onekler, oncelik sirasiyla. */
  modelPriority?: string[];
  /** ONNX Runtime thread sayisi (varsayilan 2). */
  numThreads?: number;
  /** ONNX Runtime yurutucusu (varsayilan "cpu"). */
  executionProvider?: 'cpu' | 'cuda';
  /** int8 nicemlenmis model dosyalari tercih edilsin mi? (varsayilan true) */
  preferInt8?: boolean;
}

const DEFAULT_MODELS_DIR =
  process.env.DIJI_MODELS_DIR || path.join(os.homedir(), '.diji', 'models');

/**
 * Turkce ses tanima motoru.
 *
 * Birincil motor: sherpa-onnx uzerinde calisan Whisper (yerel, cevrimdisi).
 * Model bulunamazsa motor baslatma hatasi verir — sessizce sahte metin
 * uretmez. Bu, hatalarin erken ve net gorulmesini saglar.
 *
 * TURKCE DOGRULUK ZINCIRI (2026-10-28):
 *   1) Model onceligi — medium > small > base > tiny. Diskte bulunan en
 *      buyuk model kullanilir; medium Turkce'de belirgin daha dusuk WER verir.
 *   2) Ses on isleme — DC temizligi, yuksek geciren filtre, sessizlik kirpma,
 *      gurultu kapisi, otomatik kazanc (bkz. audio-preprocess.ts).
 *   3) Transkript son isleme — halusinasyon eleme, bitisik yazim duzeltmesi,
 *      alan sozlugu + bulanik eslesme (bkz. stt-postprocess.ts).
 */
export class STTEngine {
  private config: STTConfig;
  private isInitialized = false;
  private recognizer: SherpaOfflineRecognizer | null = null;
  private sampleRate = 16000;
  private modelDir: string;
  private modelPrefix: string;
  private modelPriority: string[];
  private numThreads: number;
  private executionProvider: 'cpu' | 'cuda';
  private preferInt8: boolean;
  /** Cozulen model kimligi (or. "whisper-medium"); panelde gosterilir. */
  private resolvedModelName = '';

  constructor(config: STTConfig, options: STTEngineOptions = {}) {
    this.config = config;
    this.modelDir = options.modelDir || config.modelPath || DEFAULT_MODELS_DIR;
    this.modelPrefix = options.modelPrefix || config.modelPrefix || 'small';
    this.modelPriority =
      options.modelPriority ??
      config.modelPriority ??
      (config.modelPrefix ? [config.modelPrefix] : ['medium', 'small', 'base', 'tiny']);
    this.numThreads = options.numThreads ?? config.numThreads ?? 2;
    this.executionProvider = options.executionProvider ?? config.executionProvider ?? 'cpu';
    // int8 dosyalari CPU'da belirgin hizli; computeType verilmemisse aciktir.
    this.preferInt8 =
      options.preferInt8 ?? (config.computeType ? config.computeType === 'int8' : true);
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    logInfo('STT motoru baslatiliyor', {
      provider: this.config.provider,
      model: this.config.model,
      language: this.config.language,
      modelDir: this.modelDir,
      modelPriority: this.modelPriority,
      preprocess: this.config.preprocess?.enabled !== false,
      postprocess: this.config.postprocess?.enabled !== false,
    });

    const sherpaModule = loadSherpa();
    if (!sherpaModule) {
      throw new Error(
        'STT baslatilamadi: sherpa-onnx-node bulunamadi. ' +
          'Kurulum icin "npm install sherpa-onnx-node" calistirin.'
      );
    }

    const modelFiles = this.resolveWhisperModelFiles();
    if (!modelFiles) {
      throw new Error(
        'STT baslatilamadi: Whisper model dosyalari bulunamadi.\n' +
          `Aranan dizin: ${this.modelDir}\n` +
          `Aranan onekler: ${this.modelPriority.join(', ')}\n` +
          'Modeli indirmek icin: ./scripts/download-models.sh stt'
      );
    }

    try {
      this.recognizer = new sherpaModule.OfflineRecognizer({
        featConfig: {
          sampleRate: this.sampleRate,
          featureDim: 80,
        },
        modelConfig: {
          whisper: {
            encoder: modelFiles.encoder,
            decoder: modelFiles.decoder,
            language: this.config.language,
            task: 'transcribe',
            tailPaddings: -1,
          },
          tokens: modelFiles.tokens,
          numThreads: this.numThreads,
          provider: this.executionProvider,
          debug: 0,
        },
      });

      this.isInitialized = true;
      this.resolvedModelName = `whisper-${modelFiles.prefix}`;
      logInfo('STT motoru hazir', {
        model: this.resolvedModelName,
        encoder: path.basename(modelFiles.encoder),
        int8: modelFiles.int8,
        sampleRate: this.sampleRate,
        numThreads: this.numThreads,
      });
    } catch (error) {
      logError('STT motoru baslatilamadi', error as Error, {
        modelDir: this.modelDir,
      });
      throw error;
    }
  }

  /** Cozulen model kimligi (or. "whisper-medium"). */
  getModelName(): string {
    return this.resolvedModelName || `whisper-${this.modelPrefix}`;
  }

  /**
   * Whisper model dosyalarini cozer.
   *
   * sherpa-onnx whisper paketleri su dosyalari icerir:
   *   <prefix>-encoder.onnx  (veya <prefix>-encoder.int8.onnx)
   *   <prefix>-decoder.onnx  (veya <prefix>-decoder.int8.onnx)
   *   <prefix>-tokens.txt
   *
   * Arama sirasi:
   *   1) `modelDir` bir dizinse once alt dizinler, sonra kendisi.
   *   2) `modelDir` altinda `sherpa-onnx-whisper-<onek>` dizinleri
   *      (modelPriority sirasina gore).
   *   3) DEFAULT_MODELS_DIR altinda ayni adlar.
   *
   * Model onceligi BUYUKTEN KUCUGE uygulanir: diskte medium varsa small
   * kullanilmaz.
   */
  private resolveWhisperModelFiles(): {
    encoder: string;
    decoder: string;
    tokens: string;
    prefix: string;
    int8: boolean;
  } | null {
    const candidates: Array<{ dir: string; prefix: string }> = [];
    const seenDirs = new Set<string>();

    const pushCandidate = (dir: string): void => {
      if (seenDirs.has(dir)) return;
      seenDirs.add(dir);
      candidates.push({ dir, prefix: this.detectPrefix(dir) });
    };

    // 1) Dogrudan modelDir: once alt dizinler, sonra kendisi.
    if (this.modelDir && fs.existsSync(this.modelDir)) {
      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(this.modelDir);
      } catch {
        stat = null;
      }
      if (stat?.isDirectory()) {
        let entries: string[] = [];
        try {
          entries = fs.readdirSync(this.modelDir);
        } catch {
          entries = [];
        }
        for (const entry of entries) {
          const entryPath = path.join(this.modelDir, entry);
          try {
            if (fs.statSync(entryPath).isDirectory()) pushCandidate(entryPath);
          } catch {
            // okunamayan giris: atla
          }
        }
        pushCandidate(this.modelDir);
      }
    }

    // 2) + 3) Oncelik sirasina gore bilinen dizin adlari.
    for (const prefix of this.modelPriority) {
      for (const base of new Set([this.modelDir, DEFAULT_MODELS_DIR])) {
        if (!base) continue;
        pushCandidate(path.join(base, `sherpa-onnx-whisper-${prefix}`));
        // Bazi paketler dogrudan <prefix> adiyla acilir.
        pushCandidate(path.join(base, prefix));
      }
    }

    for (const candidate of candidates) {
      if (!fs.existsSync(candidate.dir)) continue;
      const resolved = this.pickModelFiles(candidate.dir, candidate.prefix);
      if (resolved) return resolved;
    }

    return null;
  }

  /**
   * Bir dizinde oncelikli onek icin encoder/decoder/tokens uclusunu bulur.
   * `preferInt8` acikken `.int8.onnx` dosyalari tercih edilir (CPU'da ~3x hiz).
   */
  private pickModelFiles(
    dir: string,
    fallbackPrefix: string
  ): { encoder: string; decoder: string; tokens: string; prefix: string; int8: boolean } | null {
    const prefixes: string[] = [];
    if (fallbackPrefix) prefixes.push(fallbackPrefix);
    for (const prefix of this.modelPriority) {
      if (!prefixes.includes(prefix)) prefixes.push(prefix);
    }
    const detected = this.detectPrefix(dir);
    if (detected && !prefixes.includes(detected)) prefixes.push(detected);

    for (const prefix of prefixes) {
      const base = path.join(dir, prefix);
      const encoderInt8 = `${base}-encoder.int8.onnx`;
      const decoderInt8 = `${base}-decoder.int8.onnx`;
      const encoderFp32 = `${base}-encoder.onnx`;
      const decoderFp32 = `${base}-decoder.onnx`;
      const tokens = `${base}-tokens.txt`;

      if (!fs.existsSync(tokens)) continue;

      const int8Pair =
        fs.existsSync(encoderInt8) && fs.existsSync(decoderInt8)
          ? { encoder: encoderInt8, decoder: decoderInt8 }
          : null;
      const fp32Pair =
        fs.existsSync(encoderFp32) && fs.existsSync(decoderFp32)
          ? { encoder: encoderFp32, decoder: decoderFp32 }
          : null;

      const chosen = this.preferInt8 ? int8Pair ?? fp32Pair : fp32Pair ?? int8Pair;
      if (!chosen) continue;

      return {
        encoder: chosen.encoder,
        decoder: chosen.decoder,
        tokens,
        prefix,
        int8: chosen === int8Pair,
      };
    }

    return null;
  }

  /** Dizindeki *-encoder[.int8].onnx dosyasindan model onekini bulur. */
  private detectPrefix(dir: string): string {
    try {
      for (const entry of fs.readdirSync(dir)) {
        const match = entry.match(/^(.*?)-encoder(?:\.int8)?\.onnx$/);
        if (match) return match[1];
      }
    } catch {
      // okunamayan dizin: varsayilana dus
    }
    return this.modelPrefix;
  }

  /**
   * 16-bit mono PCM buffer'ini transkribe eder.
   *
   * Zincir: on isleme → Whisper → son isleme. On isleme tamamen sessiz
   * segmenti bosaltirsa model HIC calistirilmaz (halusinasyon + CPU israfi
   * onlenir).
   */
  async transcribe(audioBuffer: Buffer): Promise<STTResult> {
    if (!this.isInitialized || !this.recognizer) {
      throw new Error('STT motoru baslatilmamis');
    }

    const startTime = Date.now();
    const modelName = this.getModelName();

    try {
      // ---------------------------------------------------------- on isleme
      const preBegin = Date.now();
      let pre: PreprocessResult;
      try {
        pre = preprocessAudio(audioBuffer, this.config.preprocess);
      } catch (error) {
        // On isleme hatasi transkripsiyonu ENGELLEMEZ: ham sesle devam edilir.
        logWarn('Ses on isleme hatasi, ham ses kullanilacak', {
          error: (error as Error).message,
        });
        pre = {
          buffer: audioBuffer,
          inputMs: (audioBuffer.length / 32) | 0,
          outputMs: (audioBuffer.length / 32) | 0,
          gainDb: 0,
          trimmedMs: 0,
          inputRms: 0,
          outputRms: 0,
          isEmpty: audioBuffer.length === 0,
        };
      }
      const preprocessMs = Date.now() - preBegin;

      if (pre.isEmpty || pre.buffer.length < 16000 * 2 * 0.2) {
        logDebug('On isleme sonrasi segment cok kisa/sessiz, STT atlandi', {
          inputMs: Math.round(pre.inputMs),
          outputMs: Math.round(pre.outputMs),
        });
        return {
          text: '',
          rawText: '',
          isFinal: true,
          language: this.config.language,
          confidence: 0,
          duration: Date.now() - startTime,
          preprocessMs,
          postprocessMs: 0,
          fixes: 0,
          model: modelName,
          silent: true,
          preprocess: {
            inputMs: pre.inputMs,
            outputMs: pre.outputMs,
            gainDb: pre.gainDb,
            trimmedMs: pre.trimmedMs,
            inputRms: pre.inputRms,
            outputRms: pre.outputRms,
          },
        };
      }

      // ---------------------------------------------------------- tanima
      const samples = this.pcm16ToFloat32(pre.buffer);

      if (samples.length === 0) {
        return {
          text: '',
          rawText: '',
          isFinal: true,
          language: this.config.language,
          confidence: 0,
          duration: Date.now() - startTime,
          preprocessMs,
          postprocessMs: 0,
          fixes: 0,
          model: modelName,
          silent: true,
        };
      }

      const stream = this.recognizer.createStream();
      stream.acceptWaveform({ sampleRate: this.sampleRate, samples });
      await this.recognizer.decodeAsync(stream);
      const result = this.recognizer.getResult(stream);

      const rawText = (result.text || '').trim();

      // ---------------------------------------------------------- son isleme
      const postBegin = Date.now();
      let text = rawText;
      let fixes = 0;
      let dropped = false;
      try {
        const post = postprocessTranscript(rawText, this.config.postprocess);
        text = post.text;
        fixes = post.fixes;
        dropped = post.dropped;
      } catch (error) {
        logWarn('Transkript son isleme hatasi, ham metin kullanilacak', {
          error: (error as Error).message,
        });
      }
      const postprocessMs = Date.now() - postBegin;

      const duration = Date.now() - startTime;

      logDebug('Transkripsiyon tamamlandi', {
        text,
        rawText: rawText !== text ? rawText : undefined,
        duration,
        preprocessMs,
        postprocessMs,
        fixes,
        dropped,
        model: modelName,
        sampleCount: samples.length,
        gainDb: Number(pre.gainDb.toFixed(2)),
        trimmedMs: Math.round(pre.trimmedMs),
        detectedLang: result.lang,
      });

      if (dropped) {
        logInfo('STT halusinasyonu elendi', { rawText, model: modelName });
      }

      return {
        text,
        rawText,
        isFinal: true,
        language: result.lang || this.config.language,
        confidence: text.length > 0 ? 0.9 : 0,
        duration,
        preprocessMs,
        postprocessMs,
        fixes,
        model: modelName,
        silent: false,
        preprocess: {
          inputMs: pre.inputMs,
          outputMs: pre.outputMs,
          gainDb: pre.gainDb,
          trimmedMs: pre.trimmedMs,
          inputRms: pre.inputRms,
          outputRms: pre.outputRms,
        },
      };
    } catch (error) {
      logError('Transkripsiyon hatasi', error as Error, {
        size: audioBuffer.length,
        model: modelName,
      });
      throw error;
    }
  }

  /**
   * Artimli transkripsiyon.
   * NOT: Whisper cevrimdisi (offline) bir modeldir; gercek artimli sonuc
   * uretmez. Bu yuzden her tampon dolarsa tek bir "final" olayi yayinlanir.
   */
  async *transcribeStream(
    audioChunks: AsyncGenerator<Buffer, void, unknown>,
    chunkSeconds = 1.0
  ): AsyncGenerator<STTStreamEvent, void, unknown> {
    if (!this.isInitialized) {
      throw new Error('STT motoru baslatilmamis');
    }

    const bytesPerSecond = this.sampleRate * 2; // 16-bit mono
    const chunkBytes = Math.max(bytesPerSecond, Math.floor(bytesPerSecond * chunkSeconds));
    let pending: Buffer[] = [];
    let pendingBytes = 0;

    try {
      for await (const chunk of audioChunks) {
        pending.push(chunk);
        pendingBytes += chunk.length;

        if (pendingBytes < chunkBytes) continue;

        const combined = Buffer.concat(pending);
        pending = [];
        pendingBytes = 0;

        const result = await this.transcribe(combined);
        if (result.text) {
          yield {
            type: 'final',
            text: result.text,
            isFinal: true,
            timestamp: new Date(),
          };
        }
      }

      if (pendingBytes > bytesPerSecond * 0.2) {
        const result = await this.transcribe(Buffer.concat(pending));
        if (result.text) {
          yield {
            type: 'final',
            text: result.text,
            isFinal: true,
            timestamp: new Date(),
          };
        }
      }
    } catch (error) {
      logError('Akisli transkripsiyon hatasi', error as Error);
      yield {
        type: 'error',
        text: '',
        isFinal: false,
        timestamp: new Date(),
      };
    }
  }

  /** 16-bit little-endian PCM -> normalize edilmis Float32 (-1..1) */
  private pcm16ToFloat32(buffer: Buffer): Float32Array {
    const sampleCount = Math.floor(buffer.length / 2);
    const samples = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      const value = buffer.readInt16LE(i * 2);
      samples[i] = value < 0 ? value / 0x8000 : value / 0x7fff;
    }
    return samples;
  }

  async dispose(): Promise<void> {
    if (this.recognizer) {
      try {
        this.recognizer.free?.();
      } catch (error) {
        logWarn('STT modeli kapatilirken hata', {
          error: (error as Error).message,
        });
      }
      this.recognizer = null;
    }

    this.isInitialized = false;
    logInfo('STT motoru kapatildi', { model: this.resolvedModelName || this.config.model });
  }
}

export const createSTTEngine = (config: STTConfig, options?: STTEngineOptions): STTEngine => {
  return new STTEngine(config, options);
};
