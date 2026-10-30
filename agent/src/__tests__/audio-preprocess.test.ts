import {
  applyNoiseGate,
  autoGainControl,
  float32ToPcm16,
  highPassFilter,
  pcm16ToFloat32,
  preprocessAudio,
  removeDcOffset,
  trimSilence,
} from '../audio-preprocess';

/**
 * Ses ön işleme testleri.
 *
 * Sinyaller sentetiktir (sinüs + DC + gürültü); model dosyası gerektirmez.
 * Her test zincirin tek bir halkasını doğrular.
 */

const SAMPLE_RATE = 16000;

/** Belirtilen süre ve genlikte sinüs üretir (Float32, -1..1). */
function sine(seconds: number, freqHz: number, amplitude: number): Float32Array {
  const count = Math.round(seconds * SAMPLE_RATE);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / SAMPLE_RATE);
  }
  return samples;
}

function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

describe('PCM dönüşümleri', () => {
  it('Float32 → PCM16 → Float32 turu değeri korur', () => {
    const original = sine(0.05, 440, 0.5);
    const restored = pcm16ToFloat32(float32ToPcm16(original));
    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i += 37) {
      expect(Math.abs(restored[i] - original[i])).toBeLessThan(0.001);
    }
  });

  it('tepe değerleri kırpar (taşma yok)', () => {
    const loud = new Float32Array([2.5, -2.5, 0.5]);
    const pcm = float32ToPcm16(loud);
    expect(pcm.readInt16LE(0)).toBe(32767);
    expect(pcm.readInt16LE(2)).toBe(-32768);
  });
});

describe('removeDcOffset', () => {
  it('sabit DC bileşenini kaldırır', () => {
    const samples = sine(0.2, 440, 0.2);
    for (let i = 0; i < samples.length; i++) samples[i] += 0.1;

    const cleaned = removeDcOffset(samples);
    let mean = 0;
    for (let i = 0; i < cleaned.length; i++) mean += cleaned[i];
    mean /= cleaned.length;

    expect(Math.abs(mean)).toBeLessThan(1e-6);
  });

  it('DC yoksa sinyale dokunmaz', () => {
    const samples = sine(0.05, 440, 0.3);
    expect(removeDcOffset(samples)).toBe(samples);
  });
});

describe('highPassFilter', () => {
  it('alçak frekanslı (30 Hz) bileşeni zayıflatır', () => {
    const low = sine(0.5, 30, 0.5);
    const filtered = highPassFilter(low, 300);
    // İlk örneklerde geçici (transient) olur; kuyruk bölgesine bakılır.
    const tailFrom = Math.floor(low.length * 0.5);
    const before = rms(low.subarray(tailFrom));
    const after = rms(filtered.subarray(tailFrom));
    expect(after).toBeLessThan(before * 0.5);
  });

  it('konuşma bandındaki (1 kHz) bileşeni korur', () => {
    const mid = sine(0.3, 1000, 0.5);
    const filtered = highPassFilter(mid, 80);
    const tailFrom = Math.floor(mid.length * 0.5);
    const before = rms(mid.subarray(tailFrom));
    const after = rms(filtered.subarray(tailFrom));
    expect(after).toBeGreaterThan(before * 0.7);
  });

  it('cutoff 0 ise sinyali aynen döndürür', () => {
    const samples = sine(0.05, 440, 0.3);
    expect(highPassFilter(samples, 0)).toBe(samples);
  });
});

describe('trimSilence', () => {
  it('baştaki ve sondaki sessizliği kırpar', () => {
    const silence = new Float32Array(Math.round(0.5 * SAMPLE_RATE));
    const speech = sine(0.4, 300, 0.3);
    const combined = new Float32Array(silence.length * 2 + speech.length);
    combined.set(silence, 0);
    combined.set(speech, silence.length);
    combined.set(silence, silence.length + speech.length);

    const result = trimSilence(combined, 0.006, 0);
    // Kırpılan süre ~1 sn olmalı (0.5 + 0.5).
    expect(result.trimmedMs).toBeGreaterThan(800);
    expect(result.samples.length).toBeLessThan(combined.length);
    expect(rms(result.samples)).toBeGreaterThan(0.1);
  });

  it('tamamen sessiz segmentte boş dizi döndürür', () => {
    const silence = new Float32Array(Math.round(0.5 * SAMPLE_RATE));
    const result = trimSilence(silence, 0.006, 120);
    expect(result.samples.length).toBe(0);
  });

  it('tümü konuşma ise kopya oluşturmaz', () => {
    const speech = sine(0.3, 300, 0.4);
    const result = trimSilence(speech, 0.006, 0);
    expect(result.samples).toBe(speech);
    expect(result.trimmedMs).toBe(0);
  });
});

describe('applyNoiseGate', () => {
  it('eşiğin altındaki pencereleri sıfırlar', () => {
    const quiet = new Float32Array(Math.round(0.2 * SAMPLE_RATE));
    for (let i = 0; i < quiet.length; i++) quiet[i] = 0.0005;

    const gated = applyNoiseGate(quiet, 0.0025);
    let nonzero = 0;
    for (let i = 0; i < gated.length; i++) if (gated[i] !== 0) nonzero++;
    expect(nonzero).toBe(0);
  });

  it('konuşma düzeyindeki sinyali korur', () => {
    const speech = sine(0.2, 300, 0.2);
    const gated = applyNoiseGate(speech, 0.0025);
    expect(rms(gated)).toBeGreaterThan(0.1);
  });
});

describe('autoGainControl', () => {
  it('düşük seviyeli konuşmayı hedef RMS\'e yaklaştırır', () => {
    const quietSpeech = sine(0.5, 300, 0.01);
    const { samples, gainDb } = autoGainControl(quietSpeech, 0.06, 18);
    expect(gainDb).toBeGreaterThan(3);
    expect(rms(samples)).toBeGreaterThan(rms(quietSpeech) * 2);
  });

  it('kazancı maxGainDb ile sınırlar', () => {
    const veryQuiet = sine(0.5, 300, 0.0005);
    const { gainDb } = autoGainControl(veryQuiet, 0.06, 6);
    expect(gainDb).toBeLessThanOrEqual(6.01);
  });

  it('yeterince yüksek sinyali kısmaz (kazanç 0 dB)', () => {
    const loud = sine(0.3, 300, 0.5);
    const { samples, gainDb } = autoGainControl(loud, 0.06, 18);
    expect(gainDb).toBe(0);
    expect(samples).toBe(loud);
  });

  it('kazanç sonrası ±1 aralığını aşmaz', () => {
    const speech = sine(0.3, 300, 0.4);
    for (let i = 0; i < speech.length; i += 100) speech[i] = 0.95;
    const { samples } = autoGainControl(speech, 0.06, 18);
    for (let i = 0; i < samples.length; i++) {
      expect(samples[i]).toBeLessThanOrEqual(1);
      expect(samples[i]).toBeGreaterThanOrEqual(-1);
    }
  });
});

describe('preprocessAudio (uçtan uca)', () => {
  it('DC + sessizlik + düşük seviye kombinasyonunu temizler', () => {
    const silence = new Float32Array(Math.round(0.4 * SAMPLE_RATE));
    const speech = sine(0.4, 300, 0.02);
    const combined = new Float32Array(silence.length * 2 + speech.length);
    combined.set(silence, 0);
    combined.set(speech, silence.length);
    combined.set(silence, silence.length + speech.length);
    for (let i = 0; i < combined.length; i++) combined[i] += 0.05;

    const result = preprocessAudio(float32ToPcm16(combined));

    expect(result.isEmpty).toBe(false);
    expect(result.trimmedMs).toBeGreaterThan(500);
    expect(result.outputMs).toBeLessThan(result.inputMs);
    expect(result.gainDb).toBeGreaterThan(0);
    expect(result.outputRms).toBeGreaterThan(result.inputRms);
  });

  it('tamamen sessiz segmenti boş olarak işaretler', () => {
    const silence = new Float32Array(Math.round(1.0 * SAMPLE_RATE));
    const result = preprocessAudio(float32ToPcm16(silence));
    expect(result.isEmpty).toBe(true);
    expect(result.buffer.length).toBe(0);
  });

  it('enabled=false iken girişi aynen korur', () => {
    const speech = sine(0.2, 300, 0.2);
    const pcm = float32ToPcm16(speech);
    const result = preprocessAudio(pcm, { enabled: false });
    expect(result.buffer).toBe(pcm);
    expect(result.trimmedMs).toBe(0);
    expect(result.gainDb).toBe(0);
  });
});
