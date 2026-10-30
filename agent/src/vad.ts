import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { VADConfig } from '@diji/shared';
import { logInfo, logError, logDebug, logWarn } from '@diji/shared';

/**
 * sherpa-onnx-node ceviri tipleri (paket .d.ts saglamaz).
 */
interface SherpaSpeechSegment {
  start?: number;
  samples: Float32Array;
}

interface SherpaVad {
  acceptWaveform(samples: Float32Array): void;
  isEmpty(): boolean;
  isDetected(): boolean;
  pop(): void;
  clear(): void;
  reset(): void;
  flush(): void;
  front(enableExternalBuffer?: boolean): SherpaSpeechSegment;
  free?(): void;
}

interface SherpaModule {
  Vad: new (config: unknown, bufferSizeInSeconds: number) => SherpaVad;
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

export interface VADResult {
  isSpeech: boolean;
  confidence: number;
  /** Sessizlik suresi (ms) — tur sonu karari icin kullanilir. */
  silenceDurationMs: number;
  /** Kisa pencere RMS ses seviyesi (0..1). UI gostergesi icin. */
  audioLevel: number;
}

/** Pipeline'in bekledigi akis olayi tipi (VAD tek seferlik sonuc uretir). */
export interface VADStreamEvent {
  type: 'speech-start' | 'speech-end' | 'audio';
  isSpeech: boolean;
  confidence: number;
  audioLevel: number;
  timestamp: Date;
}

export interface SpeechSegment {
  samples: Float32Array;
  startSample: number;
  durationMs: number;
}

export interface VADEngineOptions {
  /** silero_vad.onnx dosya yolu. */
  modelPath?: string;
  /** Dahili tampon suresi (saniye). */
  bufferSizeInSeconds?: number;
}

const DEFAULT_MODELS_DIR =
  process.env.DIJI_MODELS_DIR || path.join(os.homedir(), '.diji', 'models');

/**
 * Silero VAD tabanli konusma etkinligi algilama.
 *
 * Gercek model dosyasi yoksa baslatma hatasi verir. Sahte (mock) sonuc
 * uretmez; boylece "sessizlikte konusuyor" gibi yanlis davranislar olusmaz.
 */
export class VADEngine {
  private config: VADConfig;
  private isInitialized = false;
  private vad: SherpaVad | null = null;
  private modelPath: string;
  private bufferSizeInSeconds: number;
  private startedAt = 0;
  private lastSpeechAt = 0;
  private hasSpeech = false;
  /** Anlik konusma durumu (histerezis ile). */
  private isSpeakingNow = false;

  constructor(config: VADConfig, options: VADEngineOptions = {}) {
    this.config = config;
    this.modelPath = options.modelPath || path.join(DEFAULT_MODELS_DIR, 'silero_vad.onnx');
    this.bufferSizeInSeconds = options.bufferSizeInSeconds ?? 30;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    logInfo('VAD motoru baslatiliyor', {
      provider: this.config.provider,
      threshold: this.config.threshold,
      modelPath: this.modelPath,
    });

    const sherpaModule = loadSherpa();
    if (!sherpaModule) {
      throw new Error(
        'VAD baslatilamadi: sherpa-onnx-node bulunamadi. ' +
          '"npm install sherpa-onnx-node" calistirin.'
      );
    }

    if (!fs.existsSync(this.modelPath)) {
      throw new Error(
        'VAD baslatilamadi: silero_vad.onnx bulunamadi.\n' +
          `Aranan yol: ${this.modelPath}\n` +
          'Modeli indirmek icin: ./scripts/download-models.sh vad'
      );
    }

    try {
      this.vad = new sherpaModule.Vad(
        {
          sileroVad: {
            model: this.modelPath,
            threshold: this.config.threshold,
            minSilenceDuration: this.config.minSilenceDuration,
            minSpeechDuration: this.config.minSpeechDuration,
            windowSize: 512,
          },
          sampleRate: this.config.sampleRate || 16000,
          numThreads: 1,
          provider: 'cpu',
          debug: 0,
        },
        this.bufferSizeInSeconds
      );

      this.isInitialized = true;
      logInfo('VAD motoru hazir');
    } catch (error) {
      logError('VAD motoru baslatilamadi', error as Error, {
        modelPath: this.modelPath,
      });
      throw error;
    }
  }

  /**
   * Ham PCM (16-bit mono) parcasini VAD'e besler.
   * Konusma var mi ve ne kadar sessizlik oldugu bilgisini dondurur.
   */
  processAudio(audioBuffer: Buffer): VADResult {
    if (!this.isInitialized || !this.vad) {
      throw new Error('VAD motoru baslatilmamis');
    }

    const now = Date.now();
    if (this.startedAt === 0) this.startedAt = now;

    const samples = this.pcm16ToFloat32(audioBuffer);
    // Silero 512'lik pencereler bekler; kalanlari kirp.
    const windowSize = 512;
    const usableLength = Math.floor(samples.length / windowSize) * windowSize;

    if (usableLength > 0) {
      this.vad.acceptWaveform(samples.subarray(0, usableLength));
    }

    const detected = this.vad.isDetected();

    if (detected) {
      this.hasSpeech = true;
      this.lastSpeechAt = now;
    }

    const silenceDurationMs =
      this.hasSpeech && this.lastSpeechAt > 0 ? now - this.lastSpeechAt : now - this.startedAt;

    // Tespit edilen segmentleri bosalt (bellek birikmesini onler).
    while (!this.vad.isEmpty()) {
      this.vad.pop();
    }

    if (detected) {
      this.isSpeakingNow = true;
    } else if (
      this.isSpeakingNow &&
      silenceDurationMs >= this.config.minSilenceDuration * 1000
    ) {
      this.isSpeakingNow = false;
    }

    const audioLevel = this.computeRms(samples);

    // TESHIS TUTARLILIGI: `detected` Silero'nun icin durumudur ve
    // `minSilenceDuration` dolana kadar (0,6 sn) konusma bittikten sonra da
    // `true` kalir. Bu sirada `audioLevel` 0,000'e dusebilir; panele
    // "konusma algilandi (guven %100)" + "seviye 0.000" yazmak yanilticiydi
    // (kullanici "sesim alinmiyor" diye yorumluyor).
    //
    // Bu yuzden pencere icinde HIC AC enerji yoksa (duz cizgi / tam sifir)
    // konusma kabul edilmez. Esik gurultu tabaninin ALTINDA secildi: gercek
    // oda gurultusu (p50 ~0,003 after x3 scaling) etkilenmez, yalnizca
    // gercekten sifir olan pencereler elenir.
    const silentWindow = audioLevel <= 0.002;
    const isSpeech = detected && !silentWindow;

    if (detected && silentWindow) {
      logDebug('VAD icin durumu acik ama pencere sessiz; konusma sayilmadi', {
        audioLevel,
        silenceDurationMs,
      });
    }

    logDebug('VAD sonucu', {
      isSpeech,
      detected,
      silenceDurationMs,
      audioLevel,
      sampleCount: samples.length,
    });

    return {
      isSpeech,
      // Guven yalnizca gercekten konusma sayildiginda 1'dir; aksi halde 0.
      confidence: isSpeech ? 1 : 0,
      silenceDurationMs: Math.max(0, silenceDurationMs),
      audioLevel,
    };
  }

  /**
   * Eski API uyumlulugu: pipeline `isSpeech()` adini kullaniyor.
   * `processAudio` ile ayni sonucu dondurur (audioLevel dahil).
   */
  isSpeech(audioBuffer: Buffer): VADResult {
    return this.processAudio(audioBuffer);
  }

  /** Kisa pencere RMS seviyesi (0..1). */
  private computeRms(samples: Float32Array): number {
    if (samples.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sum / samples.length);
    return Math.min(1, Math.max(0, rms * 3));
  }

  /**
   * Konusma bitip sessizlik esigi asildi mi?
   */
  isTurnEnd(silenceDurationMs: number): boolean {
    return this.hasSpeech && silenceDurationMs >= this.config.minSilenceDuration * 1000;
  }

  /** Konusma tamponunu sifirlar (yeni tur baslangici). */
  reset(): void {
    if (this.vad) {
      this.vad.reset();
      this.vad.clear();
    }
    this.startedAt = Date.now();
    this.lastSpeechAt = 0;
    this.hasSpeech = false;
    this.isSpeakingNow = false;
  }

  /** 16-bit little-endian PCM -> Float32 (-1..1) */
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
    if (this.vad) {
      try {
        this.vad.free?.();
      } catch (error) {
        logWarn('VAD modeli kapatilirken hata', {
          error: (error as Error).message,
        });
      }
      this.vad = null;
    }
    this.isInitialized = false;
    logInfo('VAD motoru kapatildi');
  }
}

export const createVADEngine = (
  config: VADConfig,
  options?: VADEngineOptions
): VADEngine => {
  return new VADEngine(config, options);
};

/**
 * Geriye donuk uyumluluk: eski isim `VADProcessor`.
 * Gercek Silero VAD motorunun ayni sinifidir.
 */
export { VADEngine as VADProcessor };

/** Geriye donuk uyumluluk fabrikasi. */
export const createVADProcessor = createVADEngine;
