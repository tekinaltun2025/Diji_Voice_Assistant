/**
 * Diji köprü sözleşmesi (Electron preload → renderer).
 *
 * Tek doğruluk kaynağı: `electron/preload.cjs` içinde `contextBridge` ile
 * açılan `window.diji` yüzeyi. Tarayıcıda (`vite dev`, 5174) bu nesne YOKTUR;
 * bu yüzden `Window.diji` **opsiyoneldir** ve tüm erişimler `window.diji?.`
 * optional chaining ile yapılmalıdır.
 *
 * Ajan tarafındaki şema karşılıkları:
 * - `GET /state` → {@link StatePayload}
 * - SSE `/events` → `snapshot` (type alanı yok) | {@link TelemetryEvent}
 */

/** Aşama durumları — ajan `agent/src/telemetry.ts` ile aynı. */
export type StageStatus = "active" | "idle" | "ready" | "error";

/**
 * Tek bir boru hattı aşaması (agent, mic, vad, stt, llm, tts, playback, mcp).
 * `metrics` serbest biçimli bir sözlüktür; değerler ajan tarafında önceden
 * biçimlendirilmiş metin veya sayı olabilir (örn. `{ "seviye": "0.6048" }`).
 */
export interface Stage {
  key: string;
  label: string;
  status: StageStatus;
  detail: string;
  metrics: Record<string, string | number>;
  updatedAt: number;
}

/** Telemetri olay akışı satırı. */
export interface LogLine {
  id: number;
  t: number;
  level: "info" | "warn" | "error" | "debug";
  stage: string;
  msg: string;
}

/** Sohbet geçmişi kaydı (hem sesli hem metin turları aynı listeye yazar). */
export interface ConversationItem {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
  source?: "voice" | "text";
  latencyMs?: number;
}

/** Tur gecikmesi ölçümü — `turn-latency` olayı ve `lastTurnLatency` alanı. */
export interface TurnLatency {
  /** Tur başlangıcından hoparlörden ilk sese kadar geçen süre. */
  totalMs: number;
  vadMs?: number;
  sttMs?: number;
  sttPreprocessMs?: number;
  sttPostprocessMs?: number;
  sttFixes?: number;
  sttModel?: string;
  llmMs?: number;
  llmFirstTokenMs?: number;
  mcpMs?: number;
  ttsFirstChunkMs?: number;
  ttsMs?: number;
  playbackMs?: number;
  firstAudioMs?: number;
  ttsEnabled?: boolean;
  mcpToolCount?: number;
  mcpServers?: string[];
  sttChars?: number;
  replyChars?: number;
  llmModel?: string;
  measuredAt?: number;
}

/** Anlık (son tur) sayaçlar — `state.turnMetrics`. */
export interface TurnMetrics {
  sttMs?: number;
  llmFirstTokenMs?: number;
  llmTotalMs?: number;
  ttsFirstByteMs?: number;
  ttsBytes?: number;
}

/** Boru hattı durum bayrakları. */
export interface PipelineStateFlags {
  isListening: boolean;
  isSpeaking: boolean;
  isProcessing: boolean;
  isBargeIn: boolean;
  lastTranscript?: string;
  lastResponse?: string;
  currentSession?: unknown;
  lastTurnLatency?: TurnLatency | null;
}

/** Ses aygıtı istatistikleri. `acRms` gerçek RMS seviyesidir (0..~1). */
export interface PipelineAudio {
  running: boolean;
  device: string;
  totalBytes?: number;
  forwardedChunks?: number;
  skippedChunks?: number;
  restarts?: number;
  acRms?: number;
  silenceThreshold?: number;
}

/** `GET /state` ve SSE `snapshot` olayının tam gövdesi. */
export interface StatePayload {
  ok: boolean;
  pid?: number;
  uptime?: number;
  pipeline?: {
    running: boolean;
    sessionId?: string | null;
    state: PipelineStateFlags;
    audio: PipelineAudio;
  };
  ttsEnabled?: boolean;
  ttsOverride?: boolean;
  stages?: Stage[];
  log?: LogLine[];
  turnMetrics?: TurnMetrics;
  lastTurnLatency?: TurnLatency | null;
  conversation?: ConversationItem[];
  conversationLimit?: number;
  stageOrder?: string[];
  /** Ajan erişilemezse köprü `{ ok:false, error }` döndürür. */
  error?: string;
  /** Onay bekleyen MCP işlemi; `null` = bekleyen onay yok. */
  pendingConfirmation?: PendingConfirmation | null;
  /** MCP sunucularının CANLI durumu (arayüz servis listesini besler). */
  mcpServers?: McpServerStatus[];
}

/**
 * Onay bekleyen MCP işlemi (ajan `telemetry.PendingConfirmation` ile aynı).
 * `expiresAt` `null` iken onay sorusu hâlâ seslendiriliyor demektir; süre
 * dolduğunda ajan işlemi reddeder ve alan `null`'a döner.
 */
export interface PendingConfirmation {
  server: string;
  tool: string;
  permission: string;
  reason: string;
  question: string;
  requestedAt: number;
  expiresAt: number | null;
}

/** Tek bir MCP sunucusunun canlı durumu (`/state.mcpServers[]`). */
export interface McpServerStatus {
  name: string;
  connected: boolean;
  toolCount: number;
  permissions: { read: boolean; write: boolean; delete: boolean };
}

/** Ayarlar ekranındaki tek bir model satırı (`/models` yanıtı). */
export interface ModelOption {
  /** Motora gönderilen kimlik (STT'de ön ek, TTS'te dizin adı, LLM'de model adı). */
  id: string;
  /** Kullanıcıya gösterilen ad. */
  label: string;
  /** `false` ise satır soluk gösterilir ve seçilemez (eksik dosya / sunucu kapalı). */
  available: boolean;
  /** Boyut, nicemleme, dosya adı gibi kısa açıklama. */
  detail: string;
}

/** `/models` yanıtının bir motor bölümü. */
export interface ModelSection {
  /** Çalışan motorun GERÇEK kimliği (yapılandırma değil). */
  current: string;
  options: ModelOption[];
}

/** LLM sağlayıcı kimliği: yerel yönlendirici veya uzak DeepSeek API'si. */
export type LlmProviderId = "local" | "deepseek";

/** Ayarlar ekranındaki tek bir LLM sağlayıcı satırı. */
export interface LlmProviderOption {
  id: LlmProviderId;
  label: string;
  baseUrl: string;
  /** `true` ise seçmek için API anahtarı gerekir (arayüz alanı açar). */
  requiresApiKey: boolean;
  /** Anahtar daha önce kaydedilmiş mi (0600 dosyada). Değeri asla gönderilmez. */
  apiKeyPresent: boolean;
  /** Şu anda çalışan sağlayıcı mı. */
  active: boolean;
}

/**
 * `/models` yanıtındaki LLM sağlayıcı bölümü.
 *
 * Neden model listesinden ayrı: sağlayıcı değişimi `baseUrl` + `apiKey` +
 * `model` alanlarını birlikte değiştirir. Ayrı tutulmazsa kullanıcı yerel
 * sunucuya `deepseek-flash` gönderebilir.
 */
export interface LlmProviderState {
  /** Çalışan sağlayıcı (motorun gerçek durumu). */
  current: LlmProviderId;
  options: LlmProviderOption[];
}

/**
 * `/models` yanıtı — Ayarlar ekranının model listeleri.
 *
 * Kaynak tamamen makinede ne varsa odur: STT/TTS seçenekleri diskteki model
 * dosyalarından, LLM seçenekleri yerel sunucunun `/v1/models` yanıtından
 * üretilir. Sabit bir "desteklenen modeller" tablosu yoktur.
 */
export interface ModelCatalog {
  ok: boolean;
  stt: ModelSection;
  tts: ModelSection;
  llm: ModelSection;
  /**
   * LLM sağlayıcı bölümü (yerel ↔ DeepSeek).
   *
   * Eski ajanlarda bulunmaz; arayüz yoksa bölümü hiç göstermez.
   */
  llmProvider?: LlmProviderState;
  /** Kataloğun okunduğu dizin (teşhis için). */
  modelsDir?: string;
  error?: string;
}

/** Model türü: ses tanıma, seslendirme, dil modeli. */
export type ModelKind = "stt" | "tts" | "llm";

/** `/models/select` yanıtı. */
export interface ModelSelectResult {
  ok: boolean;
  /** Değişiklikten sonra çalışan model kimliği. */
  current?: string;
  /** `ok:false` ise nedeni (liste dışı, dosya eksik, motor hazır değil…). */
  reason?: string;
  /** Geçiş uzun sürebilir mi (drifting-tts Python köprüsü ~60-70 sn). */
  slow?: boolean;
  /**
   * Seçim `~/.config/diji/env` dosyasına yazıldı mı.
   * `true` ise ajan yeniden başladığında da geçerli olur.
   */
  persisted?: boolean;
  /** Kalıcılık yazılamadıysa nedeni (izin hatası, disk dolu…). */
  persistError?: string;
  /** Kullanıcıya gösterilecek kalıcılık notu. */
  persistHint?: string;
  error?: string;
}

/** `POST /llm/provider` yanıtı. */
export interface LlmProviderSelectResult {
  ok: boolean;
  /** Geçişten sonraki çalışan sağlayıcı. */
  current?: LlmProviderId;
  /** `ok:false` ise nedeni. */
  reason?: string;
  /**
   * `true` ise uzak sağlayıcı için API anahtarı gerekiyor ve kayıtlı anahtar
   * yok — geçiş YAPILMADI. Arayüz parola alanını açıp tekrar göndermelidir.
   */
  apiKeyRequired?: boolean;
  /** Geçiş yapıldıysa etkin uç nokta (anahtar içermez). */
  baseUrl?: string;
  persisted?: boolean;
  persistError?: string;
  persistHint?: string;
  error?: string;
}

/** `/ask` yanıtı: HTTP 202 — yanıt metni SSE'den gelir. */
export interface AskResult {
  ok: boolean;
  accepted?: boolean;
  error?: string;
}

/** `/listen` yanıtı. */
export interface ListenResult {
  ok: boolean;
  listening?: boolean;
  error?: string;
}

/** `/tts` yanıtı. */
export interface TtsResult {
  ok: boolean;
  enabled?: boolean;
  override?: boolean;
  error?: string;
}

/** `/confirm` yanıtı. */
/**
 * Başlık çubuğundaki pencere düğmelerinin sonucu.
 * Pencere yoksa/yok edildiyse `ok:false` döner; renderer çökmez.
 */
export interface WindowActionResult {
  ok: boolean;
  /** `ok:true` ise pencerenin yeni büyütme durumu. */
  maximized?: boolean;
}

/** Pencere kontrol yüzeyi — renderer'dan `ipcRenderer` görünmeden kullanılır. */
export interface WindowControls {
  /** Pencereyi görev çubuğuna indirir. */
  minimize(): Promise<WindowActionResult>;
  /** Büyütür; zaten büyütülmüşse eski boyuta döndürür. */
  toggleMaximize(): Promise<WindowActionResult>;
  /** Pencereyi kapatır (uygulama `window-all-closed` ile çıkar). */
  close(): Promise<WindowActionResult>;
  /** Açılışta mevcut büyütme durumu (ikon ilk boyamada doğru olsun). */
  isMaximized(): Promise<boolean>;
  /** Büyütme durumu değişim aboneliği; kaldırma fonksiyonu döner. */
  onMaximizedChange(cb: (maximized: boolean) => void): () => void;
}

export interface ConfirmResult {
  ok: boolean;
  applied?: boolean;
  error?: string;
}

/** `/barge-in` yanıtı. */
export interface BargeInResult {
  ok: boolean;
  error?: string;
}

/** Ajan bağlantı durumu olayı. */
export interface ConnectionStatus {
  connected: boolean;
  error?: string;
}

/**
 * SSE telemetri olayları. `snapshot` olayının `type` alanı YOKTUR ve doğrudan
 * {@link StatePayload} gövdesidir; bu yüzden birleşimde `type` taşımayan üye
 * olarak ayrıca ele alınır.
 */
export type TelemetryEvent =
  | { type: "stage"; state: Stage }
  | { type: "log"; entry: LogLine }
  | { type: "tts-toggle"; enabled: boolean }
  | { type: "confirmation"; pending: PendingConfirmation | null }
  | { type: "turn-latency"; latency: TurnLatency }
  | { type: "conversation-update"; conversation: ConversationItem[] }
  | { type: "snapshot"; state: StatePayload };

/** `contextBridge` ile açılan dar yüzey. */
export interface DijiAPI {
  /** Ajanın tam durum görüntüsü (`GET /state`). Hata: `{ ok:false, error }`. */
  getState(): Promise<StatePayload>;
  /** Köprünün bu pencerede bulunduğunu doğrular. */
  isAvailable(): boolean;
  /** Mikrofon/ajan dinlemesini aç/kapat. */
  listen(enabled: boolean): Promise<ListenResult>;
  /** Metin sorusu gönderir (202 Accepted). Yanıt metni SSE'den gelir. */
  ask(text: string): Promise<AskResult>;
  /** TTS motorunu aç/kapat. */
  setTts(enabled: boolean): Promise<TtsResult>;
  /** Onay bekleyen işlemi yanıtla (alan adı ajan tarafında `confirmed`). */
  confirm(confirmed: boolean): Promise<ConfirmResult>;
  /** Devam eden konuşmayı/oynatmayı kes (barge-in). */
  bargeIn(): Promise<BargeInResult>;
  /** Ayarlar ekranının model listeleri (`GET /models`). */
  getModels(): Promise<ModelCatalog>;
  /** Model değiştir (`POST /models/select`). */
  selectModel(kind: ModelKind, id: string): Promise<ModelSelectResult>;
  /**
   * LLM sağlayıcısını değiştir (`POST /llm/provider`).
   *
   * Uzak sağlayıcı ilk kez seçilirken `apiKey` zorunludur; verilmezse yanıt
   * `apiKeyRequired: true` olur ve geçiş YAPILMAZ. Anahtar yalnızca 0600
   * izinli `~/.config/diji/secrets/deepseek.key` dosyasına yazılır.
   */
  selectLlmProvider(
    provider: LlmProviderId,
    apiKey?: string,
  ): Promise<LlmProviderSelectResult>;
  /** Başlık çubuğundaki pencere düğmeleri (küçült / büyüt / kapat). */
  windowControls: WindowControls;
  /** SSE telemetri aboneliği; kaldırma fonksiyonu döner. */
  onTelemetry(cb: (event: TelemetryEvent) => void): () => void;
  /** Bağlantı durumu aboneliği; kaldırma fonksiyonu döner. */
  onConnection(cb: (status: ConnectionStatus) => void): () => void;
  readonly isElectron: true;
  readonly version: string;
}

declare global {
  interface Window {
    /** Electron'da tanımlı; tarayıcıda `undefined`. */
    diji?: DijiAPI;
  }
}
