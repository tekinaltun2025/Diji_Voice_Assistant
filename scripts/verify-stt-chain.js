#!/usr/bin/env node
"use strict";

/**
 * STT zinciri uçtan uca doğrulama (model dosyası gerektirir).
 *
 * Ne yapar:
 *   1) Diskteki Whisper test WAV'ını okur (`readWave`).
 *   2) Saat üzerinden PCM16 tamponuna çevirir.
 *   3) GERÇEK `STTEngine` üzerinden (derlenmiş dist) transkripsiyon yapar.
 *   4) Ön işleme / son işleme sürelerini ve düzeltme sayısını yazdırır.
 *   5) Aynı sesi ÖN İŞLEME KAPALI olarak da çalıştırıp farkı gösterir.
 *
 * Kullanım:
 *   node scripts/verify-stt-chain.js [wav-yolu]
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const { STTEngine } = require(path.join(ROOT, 'agent', 'dist', 'stt.js'));
const { DEFAULT_AGENT_CONFIG } = require(path.join(ROOT, 'shared', 'dist', 'index.js'));

const DEFAULT_WAV = path.join(
  process.env.HOME || '',
  '.diji',
  'models',
  'sherpa-onnx-whisper-small',
  'test_wavs',
  '0.wav'
);

function float32ToPcm16(samples) {
  const out = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const scaled = samples[i] * 32767;
    const clamped = scaled > 32767 ? 32767 : scaled < -32768 ? -32768 : scaled;
    out.writeInt16LE(Math.round(clamped), i * 2);
  }
  return out;
}

async function run(label, config) {
  const engine = new STTEngine(config);
  await engine.initialize();

  const sherpa = require('sherpa-onnx-node');
  const wav = sherpa.readWave(wavPath);
  if (wav.sampleRate !== 16000) {
    throw new Error(`Beklenmeyen örnekleme oranı: ${wav.sampleRate} (16000 olmalı)`);
  }
  const pcm = float32ToPcm16(wav.samples);

  // Isınma (ilk çıkarım ONNX grafiğini kurar; ölçümü kirletmesin).
  await engine.transcribe(pcm);

  const t0 = Date.now();
  const result = await engine.transcribe(pcm);
  const wall = Date.now() - t0;

  console.log(`\n=== ${label} ===`);
  console.log('model           :', result.model);
  console.log('ham metin       :', JSON.stringify(result.rawText));
  console.log('son metin       :', JSON.stringify(result.text));
  console.log('düzeltme sayısı :', result.fixes);
  console.log('ön işleme       :', result.preprocessMs, 'ms');
  console.log('son işleme      :', result.postprocessMs, 'ms');
  console.log('çıkarım         :', Math.max(0, wall - result.preprocessMs - result.postprocessMs), 'ms');
  console.log('duvar süresi    :', wall, 'ms');
  console.log('sessiz          :', result.silent);
  if (result.preprocess) {
    const p = result.preprocess;
    console.log(
      'ses             :',
      `${Math.round(p.inputMs)} ms → ${Math.round(p.outputMs)} ms`,
      `| kırpılan ${Math.round(p.trimmedMs)} ms`,
      `| kazanç ${p.gainDb.toFixed(2)} dB`,
      `| RMS ${p.inputRms.toFixed(4)} → ${p.outputRms.toFixed(4)}`
    );
  }

  await engine.dispose();
  return result;
}

const wavPath = process.argv[2] || DEFAULT_WAV;

async function main() {
  if (!fs.existsSync(wavPath)) {
    console.error('WAV bulunamadı:', wavPath);
    process.exit(1);
  }
  console.log('WAV:', wavPath);

  const base = DEFAULT_AGENT_CONFIG.stt;

  const withChain = await run('ÖN + SON İŞLEME AÇIK', base);

  const withoutChain = await run('ZİNCİR KAPALI (referans)', {
    ...base,
    preprocess: { enabled: false },
    postprocess: { enabled: false },
  });

  console.log('\n=== KARŞILAŞTIRMA ===');
  const same = withChain.rawText.trim() === withoutChain.rawText.trim();
  console.log('ham transkript aynı mı :', same ? 'evet' : 'HAYIR');
  console.log('zincir sonrası metin   :', JSON.stringify(withChain.text));
  console.log('referans metin         :', JSON.stringify(withoutChain.text));
}

main().catch((error) => {
  console.error('DOĞRULAMA HATASI:', error && error.message ? error.message : error);
  process.exit(1);
});
