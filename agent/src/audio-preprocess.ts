import type { STTPreprocessConfig } from '@diji/shared';
import { logDebug } from '@diji/shared';

/**
 * Ses ön işleme zinciri (Türkçe STT doğruluğu için).
 *
 * NEDEN GEREKLİ:
 *   Whisper tabanlı modeller ham mikrofon sesinde üç tipik hata üretir:
 *   1) Sessiz bölgelerde halüsinasyon ("İzlediğiniz için teşekkürler",
 *      "Altyazı M.K." gibi uydurma cümleler) — sessizliği kırpmak bunu
 *      büyük ölçüde ortadan kaldırır.
 *   2) Düşük seviyeli konuşmada hece yutma — otomatik kazanç denetimi (AGC)
 *      konuşmayı modelin beklediği seviyeye getirir.
 *   3) Alçak frekanslı gürültü (fan, trafo, masa titreşimi) — yüksek geçiren
 *      filtre bunu keser.
 *
 * ZİNCİR SIRASI (önemli):
 *   DC temizliği → yüksek geçiren filtre → ön vurgu → sessizlik kırpma →
 *   gürültü kapısı → AGC
 *
 *   Kırpma, kazançtan ÖNCE yapılır: eşik ham sinyalin gerçek gürültü tabanına
 *   göre belirlenmelidir. Aksi halde AGC gürültüyü de yükseltip eşiği anlamsız
 *   kılar.
 */

/** Ön işleme sonucu: işlenmiş PCM + teşhis bilgileri. */
export interface PreprocessResult {
  /** İşlenmiş 16-bit mono PCM (girişten farklı uzunlukta olabilir). */
  buffer: Buffer;
  /** Giriş süresi (ms). */
  inputMs: number;
  /** Çıkış süresi (ms). */
  outputMs: number;
  /** Uygulanan kazanç (dB). 0 = kazanç uygulanmadı. */
  gainDb: number;
  /** Kırpılan sessizlik miktarı (ms). */
  trimmedMs: number;
  /** Giriş RMS seviyesi (0..1). */
  inputRms: number;
  /** Çıkış RMS seviyesi (0..1). */
  outputRms: number;
  /** Sessizlik kırpma sonucu tamamen boş kaldı mı? */
  isEmpty: boolean;
}

export const DEFAULT_PREPROCESS: Required<STTPreprocessConfig> = {
  enabled: true,
  highPassHz: 80,
  trimSilence: true,
  trimThreshold: 0.006,
  trimPaddingMs: 120,
  targetRms: 0.06,
  maxGainDb: 18,
  noiseGateRms: 0.0025,
  preEmphasis: 0,
};

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

/** ms → örnek sayısı. */
function msToSamples(ms: number): number {
  return Math.max(0, Math.round((ms / 1000) * SAMPLE_RATE));
}

/** 16-bit LE PCM → Float32 (-1..1). */
export function pcm16ToFloat32(buffer: Buffer): Float32Array {
  const sampleCount = Math.floor(buffer.length / BYTES_PER_SAMPLE);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const value = buffer.readInt16LE(i * BYTES_PER_SAMPLE);
    samples[i] = value < 0 ? value / 0x8000 : value / 0x7fff;
  }
  return samples;
}

/** Float32 (-1..1) → 16-bit LE PCM (kırpmalı). */
export function float32ToPcm16(samples: Float32Array): Buffer {
  const out = Buffer.allocUnsafe(samples.length * BYTES_PER_SAMPLE);
  for (let i = 0; i < samples.length; i++) {
    const scaled = samples[i] * 32767;
    const clamped = scaled > 32767 ? 32767 : scaled < -32768 ? -32768 : scaled;
    out.writeInt16LE(Math.round(clamped), i * BYTES_PER_SAMPLE);
  }
  return out;
}

/** Float32 örneklerin RMS'i (0..1). */
function computeRms(samples: Float32Array, from = 0, to = samples.length): number {
  const length = to - from;
  if (length <= 0) return 0;
  let sum = 0;
  for (let i = from; i < to; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / length);
}

/**
 * DC bileşenini (ortalama) çıkarır.
 *
 * AMD SoundWire DMIC gibi donanımlar sabit ofset üretir; bu ofset hem VAD
 * eşiğini hem transkripsiyonu bozar.
 */
export function removeDcOffset(samples: Float32Array): Float32Array {
  if (samples.length === 0) return samples;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i];
  const mean = sum / samples.length;
  if (Math.abs(mean) < 1e-4) return samples;

  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] - mean;
  return out;
}

/**
 * Birinci dereceden yüksek geçiren filtre (RC yaklaşımı).
 *
 * Alçak frekanslı gürültüyü (fan, trafo uğultusu) atar. 80 Hz kesim,
 * insan sesinin temel frekansının (kadın ~180 Hz, erkek ~100 Hz) altında
 * kalır; konuşmaya zarar vermez.
 */
export function highPassFilter(samples: Float32Array, cutoffHz: number): Float32Array {
  if (cutoffHz <= 0 || samples.length === 0) return samples;

  const dt = 1 / SAMPLE_RATE;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const alpha = rc / (rc + dt);

  const out = new Float32Array(samples.length);
  let prevIn = samples[0];
  let prevOut = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const y = alpha * (prevOut + x - prevIn);
    out[i] = y;
    prevIn = x;
    prevOut = y;
  }
  return out;
}

/** Ön vurgu: y[n] = x[n] - a*x[n-1]. Spektrumu düzleştirir. */
export function preEmphasisFilter(samples: Float32Array, coefficient: number): Float32Array {
  if (coefficient <= 0 || samples.length === 0) return samples;
  const out = new Float32Array(samples.length);
  out[0] = samples[0];
  for (let i = 1; i < samples.length; i++) {
    out[i] = samples[i] - coefficient * samples[i - 1];
  }
  return out;
}

/**
 * Baştan ve sondan sessizliği kırpar.
 *
 * 20 ms'lik pencerelerde RMS ölçülür; eşiği aşan ilk ve son pencere
 * konuşmanın sınırı sayılır. `paddingMs` kadar pay bırakılır (kelime
 * başlarındaki patlamalar kaybolmasın).
 */
export function trimSilence(
  samples: Float32Array,
  threshold: number,
  paddingMs: number
): { samples: Float32Array; trimmedMs: number } {
  if (samples.length === 0) return { samples, trimmedMs: 0 };

  const windowSamples = msToSamples(20);
  const paddingSamples = msToSamples(paddingMs);

  let firstVoiced = -1;
  let lastVoiced = -1;

  for (let start = 0; start < samples.length; start += windowSamples) {
    const end = Math.min(start + windowSamples, samples.length);
    if (computeRms(samples, start, end) >= threshold) {
      if (firstVoiced < 0) firstVoiced = start;
      lastVoiced = end;
    }
  }

  // Tamamen sessiz: boş döndür (Whisper'a gönderilmemeli).
  if (firstVoiced < 0 || lastVoiced <= firstVoiced) {
    return { samples: new Float32Array(0), trimmedMs: samples.length / SAMPLE_RATE * 1000 };
  }

  const from = Math.max(0, firstVoiced - paddingSamples);
  const to = Math.min(samples.length, lastVoiced + paddingSamples);
  const trimmed = samples.subarray(from, to);

  // Tümüyle konuşma ise gereksiz kopya yapma.
  if (from === 0 && to === samples.length) {
    return { samples, trimmedMs: 0 };
  }

  return {
    samples: new Float32Array(trimmed),
    trimmedMs: ((samples.length - trimmed.length) / SAMPLE_RATE) * 1000,
  };
}

/**
 * Gürültü kapısı: eşiğin altındaki örnekleri sıfırlar.
 *
 * Sessiz bölgelerdeki çok düşük düzeyli gürültüyü tamamen susturur; böylece
 * Whisper "boş ama gürültülü" bölgeleri konuşma sanmaz. Kısa süreli
 * sıfırlama konuşmayı bozmaz çünkü eşik çok düşük tutulur (~-52 dBFS).
 */
export function applyNoiseGate(samples: Float32Array, thresholdRms: number): Float32Array {
  if (thresholdRms <= 0 || samples.length === 0) return samples;

  const windowSamples = msToSamples(10);
  const out = new Float32Array(samples);

  for (let start = 0; start < out.length; start += windowSamples) {
    const end = Math.min(start + windowSamples, out.length);
    if (computeRms(out, start, end) < thresholdRms) {
      for (let i = start; i < end; i++) out[i] = 0;
    }
  }
  return out;
}

/**
 * Otomatik kazanç denetimi (AGC).
 *
 * Konuşma bölgesinin RMS'i `targetRms`'e çekilir; kazanç `maxGainDb` ile
 * sınırlanır. Mikrofon uzaksa (düşük seviye) konuşma kurtarılır; çok yüksek
 * seviyede kırpma oluşmayacak şekilde tepe noktası da denetlenir.
 */
export function autoGainControl(
  samples: Float32Array,
  targetRms: number,
  maxGainDb: number
): { samples: Float32Array; gainDb: number } {
  if (targetRms <= 0 || maxGainDb <= 0 || samples.length === 0) {
    return { samples, gainDb: 0 };
  }

  const rms = computeRms(samples);
  if (rms <= 1e-5) return { samples, gainDb: 0 };

  const desiredGain = targetRms / rms;
  let gain = desiredGain;
  const maxGain = Math.pow(10, maxGainDb / 20);
  if (gain > maxGain) gain = maxGain;
  // Zaten yeterince yüksekse kısma yapma (doğal dinamik korunur).
  if (gain < 1) gain = 1;

  if (Math.abs(gain - 1) < 0.01) return { samples, gainDb: 0 };

  // Tepe noktası kırpılmasın: en yüksek genliğe göre kazancı sınırla.
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
  }
  if (peak > 0) {
    const peakLimit = 0.98 / peak;
    if (gain > peakLimit) gain = peakLimit;
  }
  if (Math.abs(gain - 1) < 0.01) return { samples, gainDb: 0 };

  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i] * gain;
    out[i] = value > 1 ? 1 : value < -1 ? -1 : value;
  }

  return { samples: out, gainDb: 20 * Math.log10(gain) };
}

/**
 * Tüm ön işleme zincirini uygular.
 *
 * `options.enabled === false` ise giriş AYNEN döner (yalnızca ölçüm yapılır).
 */
export function preprocessAudio(
  pcm: Buffer,
  options: STTPreprocessConfig = {}
): PreprocessResult {
  const cfg = { ...DEFAULT_PREPROCESS, ...options };
  const inputMs = (Math.floor(pcm.length / BYTES_PER_SAMPLE) / SAMPLE_RATE) * 1000;

  if (!cfg.enabled) {
    const samplesOff = pcm16ToFloat32(pcm);
    const rms = computeRms(samplesOff);
    return {
      buffer: pcm,
      inputMs,
      outputMs: inputMs,
      gainDb: 0,
      trimmedMs: 0,
      inputRms: rms,
      outputRms: rms,
      isEmpty: samplesOff.length === 0,
    };
  }

  let samples = pcm16ToFloat32(pcm);
  const inputRms = computeRms(samples);

  samples = removeDcOffset(samples);
  samples = highPassFilter(samples, cfg.highPassHz);
  samples = preEmphasisFilter(samples, cfg.preEmphasis);

  let trimmedMs = 0;
  if (cfg.trimSilence) {
    const trimmed = trimSilence(samples, cfg.trimThreshold, cfg.trimPaddingMs);
    samples = trimmed.samples;
    trimmedMs = trimmed.trimmedMs;
  }

  if (samples.length === 0) {
    logDebug('Ön işleme sonrası ses boş (tamamen sessiz segment)', { inputMs });
    return {
      buffer: Buffer.alloc(0),
      inputMs,
      outputMs: 0,
      gainDb: 0,
      trimmedMs,
      inputRms,
      outputRms: 0,
      isEmpty: true,
    };
  }

  samples = applyNoiseGate(samples, cfg.noiseGateRms);

  const agc = autoGainControl(samples, cfg.targetRms, cfg.maxGainDb);
  samples = agc.samples;

  const outputRms = computeRms(samples);
  const outputMs = (samples.length / SAMPLE_RATE) * 1000;

  logDebug('Ses ön işleme tamamlandı', {
    inputMs: Math.round(inputMs),
    outputMs: Math.round(outputMs),
    trimmedMs: Math.round(trimmedMs),
    gainDb: Number(agc.gainDb.toFixed(2)),
    inputRms: Number(inputRms.toFixed(4)),
    outputRms: Number(outputRms.toFixed(4)),
  });

  return {
    buffer: float32ToPcm16(samples),
    inputMs,
    outputMs,
    gainDb: agc.gainDb,
    trimmedMs,
    inputRms,
    outputRms,
    isEmpty: false,
  };
}
