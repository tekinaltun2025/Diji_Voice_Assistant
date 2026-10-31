/**
 * VITS TTS Worker — sentezi ANA THREAD'DEN AYIRIR.
 *
 * NEDEN GEREKLİ (ölçümle doğrulandı):
 * `sherpa-onnx-node`'un `OfflineTts.generate()` çağrısı SENKRON bir N-API
 * çağrısıdır ve libuv iş parçacığı havuzuna gitmez. Yani çağrı sürdüğü
 * sürece Node olay döngüsü TAMAMEN durur:
 *
 *   - Mikrofon akışı işlenmez (VAD güncellenmez → barge-in algılanamaz)
 *   - Telemetri/arayüz olayları gecikir
 *   - Kontrol sunucusu istekleri bekler
 *
 * Ölçülen etki: bir cümle 200-700 ms arasında senkron blok üretiyordu.
 * Bu, "eşzamanlı dinleme + söz kesme" hedefiyle doğrudan çelişir.
 *
 * ÇÖZÜM: VITS örneği bu worker'ın KENDİ iş parçacığında yaşar. Ana thread
 * yalnızca mesaj gönderir (`postMessage`) ve yanıtı bekler; blok süresi ana
 * thread için 0 ms olur. Worker'tan dönen PCM `ArrayBuffer` olarak
 * transfer edilir (kopyalama yok).
 *
 * PROTOKOL (ana thread → worker):
 *   { type: 'init', modelFiles, speakerId, speed }
 *   { type: 'synthesize', id, text }
 *   { type: 'dispose' }
 *
 * PROTOKOL (worker → ana thread):
 *   { type: 'ready', sampleRate, numSpeakers, modelName }
 *   { type: 'result', id, audio, sampleRate, durationMs }
 *   { type: 'error', id?, message }
 */

import * as fs from 'fs';
import * as path from 'path';
import { parentPort } from 'worker_threads';

/** sherpa-onnx'in ürettiği ses nesnesi (kullanılan alanlar). */
interface SherpaGeneratedAudio {
  samples: Float32Array;
  sampleRate: number;
}

/** Worker'ın ihtiyaç duyduğu en küçük motor arayüzü. */
interface SherpaOfflineTts {
  generate(options: { text: string; sid: number; speed: number }): SherpaGeneratedAudio;
  sampleRate: number;
  numSpeakers?: number;
}

interface SherpaModule {
  OfflineTts: new (config: unknown) => SherpaOfflineTts;
}

interface ModelFiles {
  model: string;
  tokens: string;
  lexicon?: string;
  dataDir?: string;
}

interface InitMessage {
  type: 'init';
  modelFiles: ModelFiles;
  speakerId: number;
  speed: number;
}

interface SynthesizeMessage {
  type: 'synthesize';
  id: number;
  text: string;
}

interface DisposeMessage {
  type: 'dispose';
}

type InboundMessage = InitMessage | SynthesizeMessage | DisposeMessage;

/** Worker'ın ana thread'e gönderdiği mesajlar. */
type OutboundMessage =
  | { type: 'ready'; sampleRate: number; numSpeakers: number; modelName: string }
  | {
      type: 'result';
      id: number;
      audio: ArrayBuffer;
      sampleRate: number;
      durationMs: number;
    }
  | { type: 'error'; id?: number; message: string };

/**
 * `sherpa-onnx-node` modülünü yükler.
 *
 * NEDEN dinamik `require`: modül yerel bir `.node` eklentisidir; kurulu
 * değilse (yalnızca STT kullanan kurulumlar) ajan hiç açılmamalı değil,
 * yalnızca TTS başlatılamamalı. Hata çağırana açıkça bildirilir.
 */
function loadSherpa(): SherpaModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('sherpa-onnx-node');
    if (mod && typeof mod.OfflineTts === 'function') {
      return mod as SherpaModule;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Float32 (-1..1) örnekleri 16-bit little-endian PCM'e çevirir.
 *
 * NEDEN worker içinde: dönüşüm de O(n) ve ana thread'de yapılırsa kazanç
 * azalır. Ayrıca PCM hazır olarak transfer edildiği için ana thread'e hiç
 * iş kalmaz.
 */
function float32ToPcm16(samples: Float32Array): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    // Kırpma zorunlu: taşan örnekler aksi halde tıklama/ses kırılması yapar.
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  return buffer;
}

function send(message: OutboundMessage, transfer?: ArrayBuffer[]): void {
  if (!parentPort) return;
  parentPort.postMessage(message, transfer ?? []);
}

let engine: SherpaOfflineTts | null = null;
let speakerId = 0;
let speed = 1.0;

/**
 * Motoru başlatır. Ana thread bu yanıtı beklemeden sentez istemez;
 * `VitsWorkerBridge.initialize()` çözülene kadar çağrı yapılmaz.
 */
function handleInit(message: InitMessage): void {
  const sherpa = loadSherpa();
  if (!sherpa) {
    send({
      type: 'error',
      message:
        'sherpa-onnx-node bulunamadi. "npm install sherpa-onnx-node" calistirin.',
    });
    return;
  }

  const { modelFiles } = message;
  if (!fs.existsSync(modelFiles.model) || !fs.existsSync(modelFiles.tokens)) {
    send({
      type: 'error',
      message: `VITS model dosyalari bulunamadi: ${modelFiles.model}`,
    });
    return;
  }

  try {
    engine = new sherpa.OfflineTts({
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

    speakerId = message.speakerId;
    speed = message.speed;

    send({
      type: 'ready',
      sampleRate: engine.sampleRate || 22050,
      numSpeakers: engine.numSpeakers ?? 1,
      // Dizin adı seçim listesindeki kimlikle birebir aynı olmalı.
      modelName: path.basename(path.dirname(modelFiles.model)),
    });
  } catch (error) {
    send({ type: 'error', message: (error as Error).message });
  }
}

/**
 * Tek bir metni sentezler.
 *
 * DİKKAT: burada `try/catch` ZORUNLU. Yakalanmayan bir istisna worker'ı
 * sessizce öldürür; ana thread sonsuza kadar yanıt bekler ve TTS kilitlenir.
 */
function handleSynthesize(message: SynthesizeMessage): void {
  if (!engine) {
    send({ type: 'error', id: message.id, message: 'TTS motoru hazir degil' });
    return;
  }

  const cleanText = message.text.trim();
  if (!cleanText) {
    const empty = Buffer.alloc(0);
    send(
      {
        type: 'result',
        id: message.id,
        audio: empty.buffer.slice(empty.byteOffset, empty.byteOffset + empty.byteLength) as ArrayBuffer,
        sampleRate: engine.sampleRate || 22050,
        durationMs: 0,
      },
      []
    );
    return;
  }

  try {
    const audio = engine.generate({ text: cleanText, sid: speakerId, speed });
    const pcm = float32ToPcm16(audio.samples);
    const sampleRate = audio.sampleRate || engine.sampleRate || 22050;
    const durationMs = Math.round((audio.samples.length / sampleRate) * 1000);

    // Transfer edilecek ArrayBuffer'ı hazırla: kopyasız aktarım için
    // Buffer'ın kendi bellek aralığını alıyoruz.
    const arrayBuffer = pcm.buffer.slice(
      pcm.byteOffset,
      pcm.byteOffset + pcm.byteLength
    ) as ArrayBuffer;

    send(
      {
        type: 'result',
        id: message.id,
        audio: arrayBuffer,
        sampleRate,
        durationMs,
      },
      // Transfer listesi: PCM ana thread'e KOPYALANMADAN geçer.
      [arrayBuffer]
    );
  } catch (error) {
    send({ type: 'error', id: message.id, message: (error as Error).message });
  }
}

if (parentPort) {
  parentPort.on('message', (message: InboundMessage) => {
    switch (message.type) {
      case 'init':
        handleInit(message);
        break;
      case 'synthesize':
        handleSynthesize(message);
        break;
      case 'dispose':
        engine = null;
        process.exit(0);
        break;
      default:
        send({
          type: 'error',
          message: `Bilinmeyen mesaj tipi: ${String((message as { type: string }).type)}`,
        });
    }
  });
}
