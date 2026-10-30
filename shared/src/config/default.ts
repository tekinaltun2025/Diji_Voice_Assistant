import os from 'node:os';
import path from 'node:path';
import { AgentConfig } from '../types/agent';
import type { TTSConfig } from '../types/voice';

/**
 * Varsayilan yapilandirma.
 *
 * Tum ses bilesenleri yerel motorlari kullanir:
 *   - TTS: `drifting-tts` (Python, birincil) veya `sherpa-vits` (yedek)
 *   - STT/VAD: sherpa-onnx (model dosyalari `./scripts/download-models.sh all`)
 * Sure birimleri SANIYE'dir.
 *
 * LLM: surekli ayakta olan yerel OpenAI uyumlu yonlendirici
 * (http://127.0.0.1:8000/v1). `agent` modeli varsayilandir.
 */
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  livekit: {
    url: process.env.LIVEKIT_URL || 'wss://your-livekit-server.livekit.cloud',
    apiKey: process.env.LIVEKIT_API_KEY || '',
    apiSecret: process.env.LIVEKIT_API_SECRET || '',
  },
  stt: {
    provider: 'whisper',
    model: process.env.DIJI_STT_MODEL || 'whisper-small',
    language: process.env.DIJI_STT_LANGUAGE || 'tr',
    device: 'cpu',
    computeType: 'int8',
    numThreads: Number(process.env.DIJI_STT_THREADS || 2),
    /*
     * Türkçe doğruluk ayarları (2026-10-28).
     *
     * Model önceliği: medium > small > base > tiny. Diskte hangisi varsa o
     * kullanılır; `DIJI_STT_MODEL_PREFIX` ile bir model öne alınır.
     * Medium, small'a göre Türkçe'de belirgin biçimde daha düşük WER verir
     * (bedeli ~2-3x CPU gecikmesidir).
     */
    ...(process.env.DIJI_STT_MODEL_PREFIX
      ? { modelPrefix: process.env.DIJI_STT_MODEL_PREFIX }
      : {}),
    /*
     * KUSUR ONARIMI (2026-10-30): `DIJI_STT_MODEL_PREFIX` daha önce HİÇ
     * etkili değildi. `stt.ts` önceliği
     * `options.modelPriority ?? config.modelPriority ?? modelPrefix`
     * sırasıyla çözer; `modelPriority` burada her zaman tanımlı olduğu için
     * `modelPrefix` dalı hiç çalışmıyordu (Ayarlar'dan "kalıcı yap" diyen
     * kullanıcı yeniden başlatınca eski modele dönerdi).
     *
     * Çözüm: ön eki listenin BAŞINA ekle. Tek ön eke indirmiyoruz çünkü o
     * model diskte yoksa ajan hiç açılmazdı; yedek ön ekler korunur.
     */
    modelPriority: buildSttPriority(),
    preprocess: {
      enabled: process.env.DIJI_STT_PREPROCESS !== 'false',
      highPassHz: Number(process.env.DIJI_STT_HIGHPASS_HZ || 80),
      // Whisper sessiz bölgelerde halüsinasyon üretir; kırpma bunu engeller.
      trimSilence: true,
      trimThreshold: Number(process.env.DIJI_STT_TRIM_THRESHOLD || 0.006),
      trimPaddingMs: 120,
      // Mikrofon seviyesi düşükse (kullanıcı uzakta) AGC konuşmayı kurtarır.
      targetRms: Number(process.env.DIJI_STT_TARGET_RMS || 0.06),
      maxGainDb: Number(process.env.DIJI_STT_MAX_GAIN_DB || 18),
      noiseGateRms: Number(process.env.DIJI_STT_NOISE_GATE_RMS || 0.0025),
      preEmphasis: 0,
    },
    postprocess: {
      enabled: process.env.DIJI_STT_POSTPROCESS !== 'false',
      stripHallucinations: true,
      fixSpacing: true,
      fuzzyDistance: Number(process.env.DIJI_STT_FUZZY_DISTANCE || 1),
      terms: [
        'gmail',
        'takvim',
        'notion',
        'slack',
        'drive',
        'chrome',
        'e-posta',
        'toplantı',
        'hatırlatıcı',
        'etkinlik',
      ],
    },
  },
  tts: buildTtsDefaults(),
  llm: buildLlmDefaults(),
  vad: {
    provider: 'silero',
    threshold: Number(process.env.DIJI_VAD_THRESHOLD || 0.5),
    minSilenceDuration: Number(process.env.DIJI_VAD_MIN_SILENCE || 0.6),
    minSpeechDuration: Number(process.env.DIJI_VAD_MIN_SPEECH || 0.25),
    sampleRate: 16000,
  },
  turnDetector: {
    provider: 'turkish-custom',
    fillerWords: ['şey', 'yani', 'işte', 'demek', 'hani'],
    conjunctions: ['ve', 'ama', 'çünkü', 'fakat', 'ancak', 'veya', 'ya da'],
    punctuationEndsTurn: true,
    maxSilenceBeforeTurn: 0.8,
  },
  mcp: {
    enabled: process.env.DIJI_MCP_ENABLED !== 'false',
    permissionGate: {
      read: true,
      write: true,
      delete: false,
    },
  },
};

/**
 * LLM saglayici tanimlari.
 *
 * Neden tablo: saglayici degistiginde `baseUrl` + `model` + `apiKey`
 * BIRLIKTE degismeli. Kullanici yalnizca "DeepSeek" secince geriye
 * `baseUrl`/`model` alanlarini elle doldurmak zorunda kalirdi ki bu da
 * pratikte yanlis yapilandirmaya (orn. yerel adrese DeepSeek anahtari
 * gonderme) yol acar.
 */
export interface LlmProviderPreset {
  id: 'local' | 'deepseek';
  label: string;
  baseUrl: string;
  /** Uzak saglayici icin onerilen model; `null` ise katalog listesinden secilir. */
  defaultModel: string | null;
  /** Anahtar zorunlu mu? Arayuz buna gore alan acar. */
  requiresApiKey: boolean;
  /** Anahtarin tutuldugu dosya (yalnizca `requiresApiKey` ise). */
  apiKeyFile?: string;
}

/**
 * DeepSeek uc noktasi.
 *
 * Kullanicinin verdigi `https://api.v1.deepseek.com` adresi DNS'te
 * COZUMLENMIYOR (curl: HTTP 000). Dogrulanan calisan adres
 * `https://api.deepseek.com`; OpenAI uyumlu yol `/v1` ile tamamlanir.
 * Yanlis adres girilirse ajan acilista LLM'e hic baglanamaz.
 */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

/** DeepSeek anahtarinin tutuldugu dosya (0600, yalnizca kullanici okur). */
export function deepseekKeyFile(): string {
  return path.join(os.homedir(), '.config', 'diji', 'secrets', 'deepseek.key');
}

export const LLM_PROVIDER_PRESETS: LlmProviderPreset[] = [
  {
    id: 'local',
    label: 'Yerel yönlendirici (127.0.0.1)',
    baseUrl: 'http://127.0.0.1:8000/v1',
    defaultModel: 'agent',
    requiresApiKey: false,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek (uzak API)',
    baseUrl: DEEPSEEK_BASE_URL,
    // Dogrulanan kimlik: `/v1/models` -> deepseek-flash (DeepSeek-V4.1-Flash).
    defaultModel: 'deepseek-flash',
    requiresApiKey: true,
    apiKeyFile: deepseekKeyFile(),
  },
];

/** Secili saglayicinin presetini dondurur; bilinmeyen deger yerel sayilir. */
export function llmProviderPreset(id: string | undefined): LlmProviderPreset {
  return (
    LLM_PROVIDER_PRESETS.find((preset) => preset.id === id) ?? LLM_PROVIDER_PRESETS[0]
  );
}

/**
 * LLM varsayilanlarini olusturur.
 *
 * Oncelik: saglayici secimi env'den (`DIJI_LLM_PROVIDER`). `deepseek` ise
 * `baseUrl`/`model`/`apiKeyFile` preset'ten gelir; aksi halde yerel
 * varsayilanlar (ve `DIJI_LLM_*` ile tek tek ezme) gecerli olur.
 */
function buildLlmDefaults(): AgentConfig['llm'] {
  /*
   * DIKKAT — `LLM_PROVIDER_PRESETS` burada KULLANILAMAZ.
   *
   * Bu fonksiyon `DEFAULT_AGENT_CONFIG` olusturulurken (dosyanin basinda)
   * cagrilir; tablo ise dosyanin ALTINDA tanimli. `const` bildirimleri
   * "temporal dead zone"a tabidir, yani buradan erisim acilista
   *   `TypeError: Cannot read properties of undefined (reading 'find')`
   * hatasi verir — canli calistirmada tam olarak bu yasandi.
   *
   * Bu yuzden gerekli degerler burada DOGRUDAN hesaplanir. Tablo yalnizca
   * arayuzun (`model-catalog.ts`) kullandigi bir sunum kaynagidir.
   * `deepseekKeyFile()` bir fonksiyon BILDIRIMI oldugu icin hosisteddir
   * (TDZ'ye tabi degil) ve buradan guvenle cagrilabilir.
   */
  const remote = process.env.DIJI_LLM_PROVIDER === 'deepseek';

  // Reasoning rezervi: iki saglayicinin modelleri de hibrit reasoning
  // kullaniyor. DeepSeek olcumu (`deepseek-flash`, max_tokens=40):
  // `content: ""`, `reasoning_content` dolu, `finish_reason: "length"`.
  // Rezerv olmadan asistan HICBIR SEY SOYLEMEZ.
  return {
    provider: remote ? 'deepseek' : 'local',
    baseUrl:
      process.env.DIJI_LLM_BASE_URL ||
      (remote ? 'https://api.deepseek.com/v1' : 'http://127.0.0.1:8000/v1'),
    model:
      process.env.DIJI_LLM_MODEL ||
      (remote ? 'deepseek-flash' : 'agent'),
    // Uzak saglayicida anahtar dosyadan okunur; yerelde yerel bir yer tutucu.
    apiKey: process.env.DIJI_LLM_API_KEY || (remote ? '' : 'sk-local'),
    ...(remote ? { apiKeyFile: deepseekKeyFile() } : {}),
    temperature: Number(process.env.DIJI_LLM_TEMPERATURE || 0.7),
    maxTokens: Number(process.env.DIJI_LLM_MAX_TOKENS || 1024),
    timeoutMs: Number(process.env.DIJI_LLM_TIMEOUT_MS || 120000),
    /*
     * `agent` bir hibrit reasoning modelidir: yanit oncesi uzun dusunme metni
     * uretir (~1.500 token) ve bu metin max_tokens butcesinden duser. Rezerv
     * olmadan yanit BOS doner. Ancak rezerv cok buyuk olursa model DAHA UZUN
     * dusunur (olculdu: 4256 token butce -> 91 sn). 1024 rezerv, 2048 mutlak
     * tavanla birlikte dengeli calisir. Reasoning kullanmayan modeller: 0.
     */
    reasoningReserve: Number(process.env.DIJI_LLM_REASONING_RESERVE || 1024),
  };
}

/**
 * TTS varsayilanlarini olusturur.
 *
 * `drifting-tts` birincil arka uctur (Vyvo/drifting-tts-tr; tek adimli
 * Turkce TTS, 89.3M params, Freya-TR-Eval WER %1,33). Yalnizca Python
 * oldugu icin Python kopru alt sureci uzerinden calisir; baslatilamazsa
 * TTS motoru otomatik olarak `sherpa-vits`'e duser (bkz. agent/src/tts.ts).
 *
 * Geri donus: `DIJI_TTS_PROVIDER=sherpa-vits`
 *
 * `model` alani yalnizca sherpa-vits icin anlamlidir; drifting-tts
 * secildiginde bilgilendirici olarak model kimligi yazilir. Bu, loglarda
 * "provider=drifting-tts, model=vits-piper-..." gibi kafa karistirici
 * bir cikti olusmasini onler.
 */
/**
 * STT öncelik listesi.
 *
 * `DIJI_STT_MODEL_PREFIX` verilmişse o ön ek **listenin başına** alınır,
 * kalan yedekler korunur. Böylece seçim kalıcı olur ama diskte o model
 * silinirse ajan yine de açılabilir (sessizce eski modele düşer).
 */
function buildSttPriority(): string[] {
  const configured = (process.env.DIJI_STT_MODEL_PRIORITY || 'medium,small,base,tiny')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const forced = (process.env.DIJI_STT_MODEL_PREFIX || '').trim();
  if (!forced) return configured;

  return [forced, ...configured.filter((item) => item !== forced)];
}

function buildTtsDefaults(): TTSConfig {
  const provider =
    (process.env.DIJI_TTS_PROVIDER as TTSConfig['provider'] | undefined) || 'drifting-tts';

  // Drifting TTS 24 kHz native uretir; boru hatti 48 kHz'e kadar temiz
  // calisir. 16 kHz, STT/VAD ile ayni frekansta kalmak icin yedek degerdir.
  const sampleRate = Number(process.env.DIJI_TTS_SAMPLE_RATE || 48000);

  if (provider === 'drifting-tts') {
    return {
      provider,
      model: process.env.DIJI_TTS_MODEL || 'Vyvo/drifting-tts-tr',
      voice: process.env.DIJI_TTS_VOICE || 'studio',
      device: 'cpu',
      speed: Number(process.env.DIJI_TTS_SPEED || 1.0),
      sampleRate,
      ...(process.env.DIJI_TTS_PYTHON ? { pythonPath: process.env.DIJI_TTS_PYTHON } : {}),
      ...(process.env.DIJI_TTS_BRIDGE ? { bridgePath: process.env.DIJI_TTS_BRIDGE } : {}),
    };
  }

  return {
    provider: 'sherpa-vits',
    /*
     * `DIJI_TTS_VITS_MODEL` ayrı bir anahtardır: `DIJI_TTS_MODEL` her iki
     * sağlayıcıda da okunduğu için, drifting-tts model kimliği (ör.
     * `Vyvo/drifting-tts-tr`) sherpa sağlayıcısına sızabiliyordu. Ayarlar
     * ekranı kalıcılık yazarken bu anahtarı kullanır.
     */
    model:
      process.env.DIJI_TTS_VITS_MODEL ||
      process.env.DIJI_TTS_MODEL ||
      'vits-piper-tr_TR-fettah-medium',
    voice: process.env.DIJI_TTS_VOICE || 'fettah',
    device: 'cpu',
    speed: Number(process.env.DIJI_TTS_SPEED || 1.0),
    speakerId: 0,
    sampleRate,
  };
}
