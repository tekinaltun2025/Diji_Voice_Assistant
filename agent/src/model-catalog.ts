/**
 * Model kataloğu — arayüzdeki Ayarlar panellerini besleyen TEK doğruluk kaynağı.
 *
 * Neden ayrı modül: model listeleri üç ayrı yerden gelir ve üçü de
 * "gerçekten kullanılabilir mi" sorusuna farklı yanıt verir:
 *
 *   1) **STT (Whisper)** — diskte `~/.diji/models/sherpa-onnx-whisper-*`
 *      dizinleri. Yalnızca `encoder` + `decoder` + `tokens` dosyalarının
 *      ÜÇÜ birden varsa liste­lenir; yarım indirilmiş bir model seçilirse
 *      ajan açılışta ölür.
 *   2) **TTS (VITS)** — diskte `vits-*` dizinleri, `.onnx` + `tokens.txt`
 *      koşuluyla.
 *   3) **LLM** — yerel OpenAI uyumlu sunucunun `/v1/models` yanıtı.
 *      Sunucu kapalıysa uydurma isim ÜRETİLMEZ; yalnızca yapılandırmadaki
 *      model tek seçenek olarak, `available: false` ile döner ki arayüz
 *      kullanıcıya "sunucu kapalı" diyebilsin.
 *
 * Kullanıcı isteği (2026-10-30): "listelerde şu an sadece mevcut modeller
 * olsun, daha sonra listeye ekleme yaparız." Bu yüzden burada sabit bir
 * "desteklenen modeller" tablosu YOKTUR — liste tamamen makinede ne varsa
 * odur.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LLM_PROVIDER_PRESETS, logDebug, logWarn } from '@diji/shared';
// `hasApiKeyFile` anahtarin ICERIGINI okumaz, yalnizca varligini bildirir.
import { hasApiKeyFile } from './env-prefs';

/** Arayüzdeki bir seçim satırının sözleşmesi. */
export interface ModelOption {
  /** Motor içinde kullanılan kimlik (STT'de ön ek, TTS'te dizin adı, LLM'de model adı). */
  id: string;
  /** Kullanıcıya gösterilecek ad. */
  label: string;
  /** Seçilebilir mi? `false` ise satır soluk gösterilir ve seçilemez. */
  available: boolean;
  /** Kısa açıklama (boyut, nicemleme, dosya adı…). */
  detail: string;
}

/**
 * LLM saglayicisi hakkinda arayuze donen ozet.
 *
 * `apiKeyPresent` YALNIZCA boolean'dir; anahtarin kendisi HICBIR ZAMAN
 * arayuze/HTTP yanitina konmaz (ekran goruntusu, gunluk veya paylasilan
 * bir terminal ciktisindan sizmasin).
 */
export interface LlmProviderState {
  current: 'local' | 'deepseek';
  /** Etkin uc nokta (anahtar icermez). */
  baseUrl: string;
  /** Arayuzde listelenecek saglayicilar. */
  options: Array<{
    id: 'local' | 'deepseek';
    label: string;
    baseUrl: string;
    requiresApiKey: boolean;
    /** Bu saglayicinin anahtari kayitli mi. */
    apiKeyPresent: boolean;
    /** Su an etkin mi (motorun gercek durumu). */
    active: boolean;
  }>;
}

export interface ModelCatalog {
  stt: { current: string; options: ModelOption[] };
  tts: { current: string; options: ModelOption[] };
  llm: { current: string; options: ModelOption[] };
  /** LLM saglayici secimi (ayri bir eksen: saglayici x model). */
  llmProvider?: LlmProviderState;
  /** Katalog hangi dizinden okundu (teşhis için). */
  modelsDir: string;
}

export type ModelKind = 'stt' | 'tts' | 'llm';

const DEFAULT_MODELS_DIR =
  process.env.DIJI_MODELS_DIR || path.join(os.homedir(), '.diji', 'models');

/** Whisper ön ekleri — küçükten büyüğe; etiket ve açıklama için. */
const WHISPER_PREFIXES = ['tiny', 'base', 'small', 'medium', 'large-v3', 'large-v2', 'large'];

const WHISPER_LABELS: Record<string, string> = {
  tiny: 'Tiny — en hızlı, en düşük doğruluk',
  base: 'Base — hızlı, temel doğruluk',
  small: 'Small — dengeli (önerilen)',
  medium: 'Medium — yüksek doğruluk, yavaş',
  'large-v3': 'Large v3 — en yüksek doğruluk, çok yavaş',
  'large-v2': 'Large v2 — yüksek doğruluk, çok yavaş',
  large: 'Large — yüksek doğruluk, çok yavaş',
};

/** Diskte var olan bir Whisper modelinin çözümlenmiş kimliği. */
interface WhisperModelOnDisk {
  prefix: string;
  dir: string;
  int8: boolean;
  sizeMb: number;
}

/**
 * Whisper model dosyalarını çözer — `stt.ts` ile AYNI kuralları kullanır.
 *
 * Kritik: `stt.ts` `modelPriority` sırasıyla ilk BULUNAN modeli yükler.
 * Burada aynı sırayla tarayıp `available` bilgisini doğru verebilmek için
 * dosya koşulları birebir aynı tutulur (`<önek>-encoder*.onnx`,
 * `<önek>-decoder*.onnx`, `<önek>-tokens.txt`).
 */
function scanWhisperModels(modelsDir: string, priority: string[]): WhisperModelOnDisk[] {
  const found: WhisperModelOnDisk[] = [];
  if (!fs.existsSync(modelsDir)) return found;

  for (const prefix of priority) {
    const candidates = [
      path.join(modelsDir, `sherpa-onnx-whisper-${prefix}`),
      path.join(modelsDir, `whisper-${prefix}`),
      path.join(modelsDir, prefix),
    ];

    for (const dir of candidates) {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;

      const files = fs.readdirSync(dir);
      const hasEncoder = files.some(
        (name) => name.startsWith(`${prefix}-encoder`) && name.endsWith('.onnx')
      );
      const hasDecoder = files.some(
        (name) => name.startsWith(`${prefix}-decoder`) && name.endsWith('.onnx')
      );
      const hasTokens = files.includes(`${prefix}-tokens.txt`) || files.includes('tokens.txt');

      // Üçü birden yoksa model YÜKLENEMEZ; listeye "kullanılamaz" olarak girer.
      if (!hasEncoder || !hasDecoder || !hasTokens) {
        found.push({ prefix, dir, int8: false, sizeMb: 0 });
        break;
      }

      const int8 = files.some(
        (name) => name.startsWith(`${prefix}-encoder.int8`) && name.endsWith('.onnx')
      );
      let sizeMb = 0;
      for (const name of files) {
        if (!name.endsWith('.onnx')) continue;
        try {
          sizeMb += fs.statSync(path.join(dir, name)).size;
        } catch {
          /* Dosya okunamıyorsa boyut 0 kalır; seçimi engellemez. */
        }
      }
      found.push({ prefix, dir, int8, sizeMb: Math.round(sizeMb / (1024 * 1024)) });
      break;
    }
  }

  return found;
}

/** `vits-*` dizinlerinden TTS seçeneklerini üretir (`tts.ts` ile aynı kural). */
function scanTtsModels(modelsDir: string): ModelOption[] {
  const options: ModelOption[] = [];
  if (!fs.existsSync(modelsDir)) return options;

  for (const entry of fs.readdirSync(modelsDir)) {
    if (!entry.startsWith('vits-')) continue;
    const dir = path.join(modelsDir, entry);
    if (!fs.statSync(dir).isDirectory()) continue;

    const files = fs.readdirSync(dir);
    const onnx = files.find((name) => name.endsWith('.onnx'));
    const hasTokens = files.includes('tokens.txt');
    const ready = Boolean(onnx && hasTokens);

    let sizeMb = onnx ? Math.round(fs.statSync(path.join(dir, onnx)).size / (1024 * 1024)) : 0;
    const speakers = files.includes('espeak-ng-data') ? 'espeak-ng' : 'tek konuşmacı';

    options.push({
      id: entry,
      // Dizin adını okunur hale getir: vits-piper-tr_TR-fettah-medium
      label: readableTtsLabel(entry),
      available: ready,
      detail: ready ? `${sizeMb} MB · ${speakers}` : 'eksik dosya (tokens.txt / .onnx)',
    });
  }

  options.sort((a, b) => a.label.localeCompare(b.label, 'tr'));
  return options;
}

/** `vits-piper-tr_TR-fettah-medium` → `Piper · Türkçe · Fettah (medium)`. */
function readableTtsLabel(dirName: string): string {
  const raw = dirName.replace(/^vits-/, '');
  const parts = raw.split('-');
  const engine = parts[0] === 'piper' ? 'Piper' : parts[0] === 'melo' ? 'MeloTTS' : parts[0];
  const rest = parts.slice(1);
  const locale = rest.find((part) => part.includes('_')) ?? '';
  const lang = locale.startsWith('tr') ? 'Türkçe' : locale || '';
  const speakers = rest.filter((part) => part !== locale).join(' ');
  const cleaned = speakers.replace(/[-_]/g, ' ').trim();
  return [engine, lang, cleaned].filter(Boolean).join(' · ');
}

/**
 * Yerel LLM sunucusundan model listesini ister.
 *
 * Sunucu kapalıysa `available: false` olan tek satır döner: kullanıcı neyin
 * seçili olduğunu görür ama "seçilebilir" sanmaz.
 */
export async function scanLlmModels(
  baseUrl: string,
  apiKey: string,
  configuredModel: string
): Promise<ModelOption[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);

  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data: any = await response.json();
    const raw: any[] = Array.isArray(data?.models) ? data.models : Array.isArray(data?.data) ? data.data : [];

    const options: ModelOption[] = [];
    for (const item of raw) {
      /*
       * KIMLIK secimi — sira kritik.
       *
       * Once `model` (llama.cpp tam dosya yolunu burada dondurur), sonra
       * `id` (OpenAI uyumlu API'lerin KIMLIGI), en son `name`.
       *
       * `name` neden sonda: DeepSeek `/v1/models` yaniti
       *   { "id": "deepseek-flash", "name": "DeepSeek-V4.1-Flash" }
       * donuyor. `name` KISAYI gosterilen addir; API ise istekte `id`
       * bekler. Canli dogrulamada `name` one alindigi icin sunucuya
       * `DeepSeek-V4.1-Flash` gonderildi — yanlis kimlik.
       */
      const id = String(item?.model ?? item?.id ?? item?.name ?? '').trim();
      if (!id) continue;
      // Sunucu tam dosya yolu döndürüyor (llama.cpp). Kullanıcıya okunur ad ver,
      // ama seçimde TAM yolu gönder: sunucu bu ada göre eşleştiriyor.
      const base = id.split('/').pop() ?? id;
      // Görünen ad: varsa sunucunun verdigi okunur `name`, yoksa kimlikten.
      const pretty = String(item?.name ?? '').trim();
      const caps: string[] = Array.isArray(item?.capabilities) ? item.capabilities : [];
      const params = String(item?.details?.parameter_size ?? '').trim();
      const quant = String(item?.details?.quantization_level ?? '').trim();
      const contextWindow = Number(item?.context_window ?? 0);
      const ctxLabel = contextWindow > 0 ? `${Math.round(contextWindow / 1024)}K bağlam` : '';
      options.push({
        id,
        label: pretty || base.replace(/\.gguf$/i, ''),
        available: true,
        detail: [params, quant, ctxLabel, caps.includes('multimodal') ? 'çok kipli' : 'metin']
          .filter(Boolean)
          .join(' · '),
      });
    }

    if (options.length === 0) {
      return [
        {
          id: configuredModel,
          label: configuredModel,
          available: false,
          detail: 'sunucu model bildirmedi',
        },
      ];
    }
    return options;
  } catch (error) {
    logDebug('LLM model listesi alinamadi', { url, error: (error as Error).message });
    return [
      {
        id: configuredModel,
        label: configuredModel,
        available: false,
        detail: 'LLM sunucusuna ulaşılamadı',
      },
    ];
  } finally {
    clearTimeout(timeout);
  }
}

export interface BuildCatalogInput {
  modelsDir?: string;
  /** Çalışan STT motorunun çözdüğü model (whisper-small gibi) veya yapılandırma değeri. */
  sttCurrent: string;
  sttPriority: string[];
  /** Çalışan TTS modeli (dizin adı ya da `drifting-tts`). */
  ttsCurrent: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmCurrent: string;
  /** Etkin LLM saglayicisi (motorun gercek durumu). */
  llmProvider: 'local' | 'deepseek';
}

/**
 * Kataloğu kurar. `current` alanları **çalışan motorun gerçek** değeridir;
 * yapılandırmadaki niyet değil — böylece arayüz "seçili" işaretini doğru
 * koyar.
 */
export async function buildModelCatalog(input: BuildCatalogInput): Promise<ModelCatalog> {
  const modelsDir = input.modelsDir || DEFAULT_MODELS_DIR;

  if (!fs.existsSync(modelsDir)) {
    logWarn('Model dizini bulunamadi', { modelsDir });
  }

  // --- STT -----------------------------------------------------------------
  const whisper = scanWhisperModels(modelsDir, input.sttPriority);
  const sttOptions: ModelOption[] = whisper.map((model) => {
    const ready = model.sizeMb > 0;
    return {
      id: model.prefix,
      label: WHISPER_LABELS[model.prefix] ?? `Whisper ${model.prefix}`,
      available: ready,
      detail: ready
        ? `${model.sizeMb} MB · ${model.int8 ? 'int8' : 'float32'}`
        : 'eksik dosya (encoder/decoder/tokens)',
    };
  });

  // Çalışan model listede yoksa (ör. özel bir dizinden yüklendiyse) yine de
  // gösterilsin; aksi halde arayüz "seçili olan yok" gibi görünür.
  const sttCurrentId = input.sttCurrent.replace(/^whisper-/, '');
  if (!sttOptions.some((option) => option.id === sttCurrentId)) {
    sttOptions.unshift({
      id: sttCurrentId,
      label: WHISPER_LABELS[sttCurrentId] ?? `Whisper ${sttCurrentId}`,
      available: true,
      detail: 'çalışan model',
    });
  }

  // --- TTS -----------------------------------------------------------------
  const ttsOptions = scanTtsModels(modelsDir);
  if (!ttsOptions.some((option) => option.id === input.ttsCurrent)) {
    // `drifting-tts` bir dizin adı değildir (Python köprüsü). Seçenek olarak
    // gösterilmez ama "çalışan sağlayıcı" bilgisi kaybolmasın diye eklenir.
    ttsOptions.unshift({
      id: input.ttsCurrent,
      label:
        input.ttsCurrent === 'drifting-tts'
          ? 'Drifting TTS (Python köprüsü)'
          : input.ttsCurrent,
      available: true,
      detail: 'çalışan sağlayıcı',
    });
  }

  // --- LLM -----------------------------------------------------------------
  const llmOptions = await scanLlmModels(input.llmBaseUrl, input.llmApiKey, input.llmCurrent);
  if (!llmOptions.some((option) => option.id === input.llmCurrent)) {
    llmOptions.unshift({
      id: input.llmCurrent,
      label: input.llmCurrent,
      available: false,
      detail: 'yapılandırılmış model (sunucuda bulunamadı)',
    });
  }

  return {
    stt: { current: sttCurrentId, options: sttOptions },
    tts: { current: input.ttsCurrent, options: ttsOptions },
    llm: { current: input.llmCurrent, options: llmOptions },
    llmProvider: buildLlmProviderState(input.llmProvider, input.llmBaseUrl),
    modelsDir,
  };
}

/**
 * Arayuzun saglayici secimini cizebilmesi icin gereken durum.
 *
 * `apiKeyPresent` her saglayici icin AYRI sorulur (DeepSeek kayitli olsa bile
 * yerel saglayicida anahtar aranmaz). Anahtarin kendisi asla okunup
 * dondurulmez; yalnizca `length > 0` bilgisi.
 */
function buildLlmProviderState(
  current: 'local' | 'deepseek',
  baseUrl: string
): LlmProviderState {
  return {
    current,
    baseUrl,
    options: LLM_PROVIDER_PRESETS.map((preset) => ({
      id: preset.id,
      label: preset.label,
      baseUrl: preset.baseUrl,
      requiresApiKey: preset.requiresApiKey,
      apiKeyPresent: preset.requiresApiKey ? hasApiKeyFile(preset.id) : true,
      active: preset.id === current,
    })),
  };
}

/**
 * Seçimin gerçekten kullanılabilir olduğunu doğrular.
 *
 * Arayüz `available` alanını zaten kontrol eder; buradaki kontrol API'nin
 * doğrudan çağrılması (curl, otomasyon) durumunda ajanı bozuk bir modele
 * geçirmeyi engeller.
 */
export function assertModelSelectable(
  catalog: ModelCatalog,
  kind: ModelKind,
  id: string
): { ok: true } | { ok: false; reason: string } {
  const section = catalog[kind];
  const match = section.options.find((option) => option.id === id);
  if (!match) return { ok: false, reason: `${kind} modeli listede yok: ${id}` };
  if (!match.available) return { ok: false, reason: `${kind} modeli kullanılamaz: ${id}` };
  return { ok: true };
}
