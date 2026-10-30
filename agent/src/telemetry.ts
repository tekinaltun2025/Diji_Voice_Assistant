/**
 * Telemetri veri yolu — boru hattının her aşamasını tek bir yerde toplar.
 *
 * Amaç: arayüzdeki teşhis paneli "ses alınıyor mu, VAD konuşma gördü mü,
 * STT ne duydu, LLM'e gitti mi, TTS ses üretti mi, hoparlör çaldı mı"
 * sorularının HER birini canlı veriyle yanıtlayabilsin. Panelde sabit/mock
 * değer yoktur: her satır gerçek bir sayaç ya da olaydan beslenir.
 *
 * Tasarım:
 *   - `update(stage, status, detail, metrics)` aşama durumunu yazar.
 *   - `log(level, stage, message)` zaman damgalı olay kaydı ekler (halka tampon).
 *   - `ingestPipelineEvent(...)` pipeline'ın kendi olaylarını aşama durumuna çevirir.
 *   - Her değişiklik `event` olarak yayınlanır: kontrol sunucusu (SSE) bunu
 *     arayüze aktarır.
 */
import { EventEmitter } from 'node:events';

export type StageKey =
  | 'agent'
  | 'mic'
  | 'vad'
  | 'stt'
  | 'llm'
  | 'tts'
  | 'playback'
  | 'mcp';

export type StageStatus = 'idle' | 'ready' | 'active' | 'warn' | 'error';

export interface StageState {
  key: StageKey;
  label: string;
  status: StageStatus;
  /** Tek satırlık insan-okur açıklama (panelde aşama altında görünür). */
  detail: string;
  /** Canlı sayaçlar (panelde küçük metrik satırı olarak gösterilir). */
  metrics: Record<string, string | number>;
  updatedAt: number;
}

export interface LogEntry {
  id: number;
  t: number;
  level: 'info' | 'warn' | 'error';
  stage: StageKey;
  msg: string;
}

/**
 * Bir sesli/metin turunun uçtan uca gecikme dökümü.
 *
 * Referans noktası **tur başlangıcıdır**: kullanıcının konuşmayı bitirdiği an
 * (VAD'in sessizlik kararı / `flushSpeechSegment` girişi) veya metin yolunda
 * isteğin kabul edildiği an. Bitiş noktası **ilk sesin hoparlöre yazıldığı
 * andır** — sentezin bittiği an değil.
 *
 * Her aşama ayrıca KENDİ İÇİNDE geçirdiği süreyi bildirir. Bu süreler
 * birbirinin içine geçebilir (ör. `vadMs` tur başlangıcından öncesine aittir,
 * `playbackMs` ilk sesden sonra devam eder); bu yüzden alanların toplamı
 * `totalMs`'e eşit olmak zorunda değildir. Arayüz her aşama kutusunda kendi
 * değerini gösterir.
 */
export interface TurnLatency {
  /** Tur başlangıcından ilk ses çıkışına kadar geçen uçtan uca süre. */
  totalMs: number;
  /**
   * VAD kararı: son konuşma karesinin zaman damgası → `flushSpeechSegment()`
   * girişi (segment kapanışı). Tur içinde birden çok segment varsa TOPLANIR.
   * Konuşmasız (metin) turda 0'dır.
   */
  vadMs: number;
  /** STT (transkripsiyon) süresi — `transcribe()` çağrısı öncesi/sonrası. */
  sttMs: number;
  /**
   * Ses ön işleme süresi (DC → high-pass → kırpma → kapı → AGC).
   * `sttMs`'e DAHİL DEĞİLDİR; ayrı ölçülür ki zincirin maliyeti görülsün.
   */
  sttPreprocessMs: number;
  /** Transkript son işleme süresi (halüsinasyon/sözlük/boşluk düzeltmesi). */
  sttPostprocessMs: number;
  /** Bu turda yapılan transkript düzeltmesi sayısı (sözlük + bulanık + boşluk). */
  sttFixes: number;
  /** Kullanılan STT modeli (ör. `whisper-medium`). */
  sttModel: string;
  /** LLM yanıt üretme süresi (istek başlangıcı → yanıt tamamı). */
  llmMs: number;
  /**
   * İstek başlangıcı → ilk içerik token'ı.
   *
   * ÖNEMLİ: pipeline akışsız yolu (`generateResponse`) kullandığı için ilk
   * token ancak yanıtın tamamıyla birlikte gelir; bu yüzden değer `llmMs` ile
   * AYNIDIR. Akış açılırsa burası gerçek ilk-token gecikmesini taşır.
   */
  llmFirstTokenMs: number;
  /** MCP araç çağrılarının toplam süresi (`handleMCPToolCalls` gövdesi). */
  mcpMs: number;
  /**
   * TTS: sentez isteği → İLK PCM parçası. Kullanıcının beklediği gecikme budur.
   * Seslendirme kapalıysa 0.
   */
  ttsFirstChunkMs: number;
  /**
   * TTS: sentez isteği → sentez TAMAMI (son PCM). `ttsFirstChunkMs`'i kapsar;
   * aradaki fark sentezin kendi üretim süresidir. Seslendirme kapalıysa 0.
   */
  ttsMs: number;
  /**
   * Çalma: ilk PCM'in hoparlöre yazıldığı an → kuyruğun boşaldığı (çalmanın
   * bittiği) an. `totalMs`'ten SONRA gerçekleşir, bu yüzden toplama katılmaz.
   */
  playbackMs: number;
  /** İlk sesin tur başına göre anı — tanım gereği `totalMs` ile aynıdır. */
  firstAudioMs: number;
  /** Tur sırasında seslendirme açık mıydı? Kapalıysa süre metnin hazır olduğu ana kadardır. */
  ttsEnabled: boolean;
  /** Bu turda çağrılan MCP aracı sayısı. */
  mcpToolCount: number;
  /** Çağrılan MCP sunucuları (`tool.name.split('.')[0]`, tekilleştirilmiş). */
  mcpServers: string[];
  /** STT transkriptinin karakter uzunluğu (metin yolunda girdi uzunluğu). */
  sttChars: number;
  /** Seslendirilen yanıtın karakter uzunluğu. */
  replyChars: number;
  /** Kullanılan LLM modeli (config `llm.model`). */
  llmModel: string;
  /** Ölçümün alındığı duvar saati zaman damgası. */
  measuredAt: number;
}

/**
 * Arayüzde gösterilen sohbet geçmişi kaydı.
 *
 * LLM'e giden `conversationHistory`'den AYRIDIR: burada sistem/tool mesajları
 * yoktur, yalnızca kullanıcının ve asistanın görünen konuşması vardır.
 */
export interface ConversationEntry {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Epoch ms. */
  at: number;
  source: 'voice' | 'text';
  /** Yalnızca asistan mesajlarında: o turun uçtan uca süresi. */
  latencyMs?: number;
}

/**
 * Onay bekleyen MCP işlemi.
 *
 * Arayüz bu kaydı görünce onay diyaloğunu açar; kullanıcı "Onayla"/"Reddet"
 * dediğinde `POST /confirm { confirmed }` çağrılır. `pending` `null` olduğunda
 * diyalog kapanır. Kayıt uydurulmaz: ajan gerçekten onay bekliyorsa doludur.
 */
export interface PendingConfirmation {
  /** MCP sunucu adı (ör. `gmail`). */
  server: string;
  /** Araç adı (ör. `gmail.send_message`). */
  tool: string;
  /** İzin sınıfı: `read` | `write` | `delete`. */
  permission: string;
  /** Neden onay istendiğinin kısa açıklaması. */
  reason: string;
  /** Kullanıcıya sorulan tam cümle (seslendirilen metin). */
  question: string;
  /** İsteğin oluşturulduğu an (epoch ms). */
  requestedAt: number;
  /**
   * Zaman aşımı anı (epoch ms). `null` = sayaç henüz başlamadı (onay sorusu
   * hâlâ seslendiriliyor). Süre dolduğunda ajan işlemi reddeder ve alan
   * `null`'a döner.
   */
  expiresAt: number | null;
}

export type TelemetryEvent =
  | { type: 'stage'; state: StageState }
  | { type: 'log'; entry: LogEntry }
  /** TTS çalışma zamanı anahtarı değişti (tray/arayüz aç-kapat). */
  | { type: 'tts-toggle'; enabled: boolean }
  /**
   * Onay bekleyen işlem değişti (istek açıldı / onaylandı / reddedildi /
   * zaman aşımı). Arayüz bu olayla onay diyaloğunu açar-kapatır.
   */
  | { type: 'confirmation'; pending: PendingConfirmation | null }
  /** Bir tur tamamlandı (ilk ses çıktı) — uçtan uca gecikme dökümü. */
  | { type: 'turn-latency'; latency: TurnLatency }
  /**
   * Sohbet geçmişi değişti (kullanıcı mesajı eklendi / asistan yanıtı hazır).
   * Tam liste gönderilir: arayüz durumu idempotent biçimde eşitler.
   */
  | { type: 'conversation-update'; conversation: ConversationEntry[] };

export const STAGE_LABELS: Record<StageKey, string> = {
  agent: 'AJAN',
  mic: 'MİKROFON',
  vad: 'VAD',
  stt: 'STT',
  llm: 'LLM',
  tts: 'TTS',
  playback: 'OYNATMA',
  mcp: 'MCP',
};

export const STAGE_ORDER: StageKey[] = [
  'agent',
  'mic',
  'vad',
  'stt',
  'llm',
  'tts',
  'playback',
  'mcp',
];

const LOG_LIMIT = 250;

/** Arayüz sohbet panelinde saklanan azami mesaj sayısı. */
export const CONVERSATION_LIMIT = 50;

/** Boş `stageMarks` üretir (tur başı/sonu sıfırlama). */
function emptyMarks(turnStart = 0, llmModel = ''): {
  turnStart: number;
  vadMs: number;
  sttMs: number;
  sttPreprocessMs: number;
  sttPostprocessMs: number;
  sttFixes: number;
  sttModel: string;
  llmMs: number;
  llmFirstTokenMs: number;
  mcpMs: number;
  ttsFirstChunkMs: number;
  ttsMs: number;
  playbackMs: number;
  sttChars: number;
  replyChars: number;
  mcpToolCount: number;
  mcpServers: string[];
  llmModel: string;
} {
  return {
    turnStart,
    vadMs: 0,
    sttMs: 0,
    sttPreprocessMs: 0,
    sttPostprocessMs: 0,
    sttFixes: 0,
    sttModel: '',
    llmMs: 0,
    llmFirstTokenMs: 0,
    mcpMs: 0,
    ttsFirstChunkMs: 0,
    ttsMs: 0,
    playbackMs: 0,
    sttChars: 0,
    replyChars: 0,
    mcpToolCount: 0,
    mcpServers: [],
    llmModel,
  };
}

class Telemetry extends EventEmitter {
  private stages = new Map<StageKey, StageState>();
  private logEntries: LogEntry[] = [];
  private logSeq = 0;

  // Tur içi zaman ölçümleri (ms)
  private tTurnStart = 0;
  private tLlmStart = 0;
  private tLlmFirst = 0;
  private tTtsStart = 0;
  private tTtsFirst = 0;
  private tSttStart = 0;
  private ttsBytes = 0;

  /**
   * Son tamamlanan turun uçtan uca gecikmesi. Tur bitince KALICI olur:
   * arayüz panelde sürekli gösterir ve yeni tur gelene kadar değişmez.
   * Hiç tur çalışmadıysa `null` (arayüz `—` gösterir).
   */
  private lastTurnLatency: TurnLatency | null = null;

  /**
   * Aşama sürelerinin tur içi ham değerleri (pipeline besler).
   *
   * Her alan o aşamanın KENDİ İÇİNDE geçirdiği süredir; birbirine eklenmez
   * (bkz. `TurnLatency` açıklaması).
   */
  private stageMarks: {
    turnStart: number;
    vadMs: number;
    sttMs: number;
    sttPreprocessMs: number;
    sttPostprocessMs: number;
    sttFixes: number;
    sttModel: string;
    llmMs: number;
    llmFirstTokenMs: number;
    mcpMs: number;
    ttsFirstChunkMs: number;
    ttsMs: number;
    playbackMs: number;
    sttChars: number;
    replyChars: number;
    mcpToolCount: number;
    mcpServers: string[];
    llmModel: string;
  } = emptyMarks();

  /**
   * Arayüzün gösterdiği sohbet geçmişi (son `CONVERSATION_LIMIT` mesaj).
   *
   * `conversationHistory` (pipeline) LLM'e giden geçmiştir ve sistem/tool
   * mesajları içerebilir; burada YALNIZCA kullanıcı ve asistanın görünen
   * mesajları tutulur.
   */
  private displayHistory: ConversationEntry[] = [];
  private conversationSeq = 0;

  /**
   * Tur kimliği sayacı.
   *
   * NEDEN GEREKLİ: `speakResponse()` çalma bitene kadar `await` edilir. Bir
   * sonraki tur bu sırada başlarsa, ÖNCEKİ turun `finally` bloğu yeni turun
   * `stageMarks` değerlerini okuyup `totalMs = 0` gibi anlamsız bir ölçüm
   * yayınlayabiliyordu (canlı ölçümde gözlendi). Her tur kendi kimliğini alır;
   * `finishTurn()` yalnızca kimlik eşleşirse yayın yapar.
   */
  private turnToken = 0;

  /**
   * Onay bekleyen MCP işlemi.
   *
   * `null` = bekleyen onay yok. Ajan onay istediğinde dolar, onay/ret/zaman
   * aşımı ile yeniden `null` olur. `/state` bu alanı yayınlar; arayüz onay
   * diyaloğunu buna göre açar.
   */
  private pendingConfirmation: PendingConfirmation | null = null;

  constructor() {
    super();
    this.setMaxListeners(50);
    for (const key of STAGE_ORDER) {
      this.stages.set(key, {
        key,
        label: STAGE_LABELS[key],
        status: 'idle',
        detail: 'bekliyor',
        metrics: {},
        updatedAt: Date.now(),
      });
    }
  }

  /** Aşama durumunu günceller ve abonelere yayınlar. */
  update(
    key: StageKey,
    status: StageStatus,
    detail: string,
    metrics?: Record<string, string | number>
  ): void {
    const prev = this.stages.get(key);
    const next: StageState = {
      key,
      label: STAGE_LABELS[key],
      status,
      detail,
      metrics: metrics ? { ...metrics } : prev ? { ...prev.metrics } : {},
      updatedAt: Date.now(),
    };
    this.stages.set(key, next);
    this.emit('event', { type: 'stage', state: next } satisfies TelemetryEvent);
  }

  /** Aşama metriklerini (durumu değiştirmeden) birleştirir. */
  metrics(key: StageKey, patch: Record<string, string | number>): void {
    const prev = this.stages.get(key);
    if (!prev) return;
    this.update(key, prev.status, prev.detail, { ...prev.metrics, ...patch });
  }

  /** Zaman damgalı olay kaydı. */
  log(level: LogEntry['level'], stage: StageKey, msg: string): void {
    const entry: LogEntry = {
      id: ++this.logSeq,
      t: Date.now(),
      level,
      stage,
      msg,
    };
    this.logEntries.push(entry);
    if (this.logEntries.length > LOG_LIMIT) {
      this.logEntries.splice(0, this.logEntries.length - LOG_LIMIT);
    }
    this.emit('event', { type: 'log', entry } satisfies TelemetryEvent);
  }

  /** Arayüz ilk açıldığında tüm durumu tek seferde alır. */
  snapshot(): {
    stages: StageState[];
    log: LogEntry[];
    turnMetrics: Record<string, number>;
    lastTurnLatency: TurnLatency | null;
    conversation: ConversationEntry[];
    pendingConfirmation: PendingConfirmation | null;
  } {
    return {
      stages: STAGE_ORDER.map(
        (k) =>
          this.stages.get(k) ?? {
            key: k,
            label: STAGE_LABELS[k],
            status: 'idle' as StageStatus,
            detail: 'bekliyor',
            metrics: {},
            updatedAt: Date.now(),
          }
      ),
      log: this.logEntries.slice(-120),
      turnMetrics: {
        sttMs: this.tSttStart ? Math.max(0, Math.round(this.tLlmStart - this.tSttStart)) : 0,
        llmFirstTokenMs: this.tLlmFirst ? Math.round(this.tLlmFirst - this.tLlmStart) : 0,
        llmTotalMs: this.tTurnStart ? Math.round(Date.now() - this.tLlmStart) : 0,
        ttsFirstByteMs: this.tTtsFirst ? Math.round(this.tTtsFirst - this.tTtsStart) : 0,
        ttsBytes: this.ttsBytes,
      },
      lastTurnLatency: this.lastTurnLatency,
      conversation: this.getConversation(),
      pendingConfirmation: this.getPendingConfirmation(),
    };
  }

  /** Son turun uçtan uca gecikmesi (hiç tur yoksa `null`). */
  getLastTurnLatency(): TurnLatency | null {
    return this.lastTurnLatency;
  }

  /** Onay bekleyen işlem (yoksa `null`). */
  getPendingConfirmation(): PendingConfirmation | null {
    return this.pendingConfirmation ? { ...this.pendingConfirmation } : null;
  }

  /**
   * Onay bekleyen işlemi ayarlar ve arayüze yayınlar.
   *
   * `null` geçilirse onay penceresi kapanır (onaylandı / reddedildi / zaman
   * aşımı). Arayüz bu olayla diyaloğu açar veya kapatır.
   */
  setPendingConfirmation(pending: PendingConfirmation | null): void {
    this.pendingConfirmation = pending ? { ...pending } : null;
    this.emit('event', {
      type: 'confirmation',
      pending: this.pendingConfirmation ? { ...this.pendingConfirmation } : null,
    } satisfies TelemetryEvent);
  }

  /**
   * Tur başlangıcını işaretler. Yeni tur başlarken aşama süreleri sıfırlanır;
   * böylece önceki turun değerleri bir sonrakine sızmaz.
   *
   * `at` varsayılan olarak "şimdi"dir; pipeline tur başlangıcını (kullanıcının
   * konuşmayı bitirdiği an) kendisi geçirir.
   *
   * @param at        Tur başlangıç zaman damgası (ms).
   * @param llmModel  Bu turda kullanılan LLM modeli (config'ten).
   */
  turnStart(at: number = Date.now(), llmModel: string = ''): number {
    this.turnToken += 1;
    this.stageMarks = emptyMarks(at, llmModel);
    this.tTurnStart = at;
    this.tLlmStart = 0;
    this.tLlmFirst = 0;
    this.tTtsStart = 0;
    this.tTtsFirst = 0;
    this.tSttStart = 0;
    this.ttsBytes = 0;
    return this.turnToken;
  }

  /** Geçerli tur kimliği (pipeline turu kapatırken eşleştirme yapar). */
  getTurnToken(): number {
    return this.turnToken;
  }

  /**
   * Aşama sürelerini tur içinde biriktirir (birden çok çağrı TOPLANIR).
   *
   * `vad` birden çok segmentte toplanır; `llm`/`mcp` birden çok çağrıda
   * toplanır. `ttsFirstChunk` ve `playback` için ilk/toplam değer ayrı
   * metotlarla yazılır (bkz. `setTtsTiming`, `setPlaybackTime`).
   */
  addStageTime(
    stage: 'vad' | 'stt' | 'llm' | 'mcp' | 'tts' | 'ttsFirstChunk',
    ms: number
  ): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    const key = `${stage}Ms` as
      | 'vadMs'
      | 'sttMs'
      | 'llmMs'
      | 'mcpMs'
      | 'ttsMs'
      | 'ttsFirstChunkMs';
    this.stageMarks[key] += Math.round(ms);
  }

  /**
   * STT ön işleme (ses temizliği) süresini kaydeder.
   *
   * `0` geçilirse alan sıfırlanmaz; sıfır zaten "ölçülmedi" anlamına gelir ve
   * bir sonraki tur `emptyMarks()` ile temizlenir.
   */
  setSttPreprocessTime(ms: number): void {
    if (Number.isFinite(ms) && ms >= 0) this.stageMarks.sttPreprocessMs = Math.round(ms);
  }

  /** STT son işleme (transkript düzeltme) süresini kaydeder. */
  setSttPostprocessTime(ms: number): void {
    if (Number.isFinite(ms) && ms >= 0) this.stageMarks.sttPostprocessMs = Math.round(ms);
  }

  /** Bu turda yapılan transkript düzeltme sayısını kaydeder (kümülatif). */
  addSttFixes(count: number): void {
    if (Number.isFinite(count) && count > 0) this.stageMarks.sttFixes += Math.round(count);
  }

  /** Kullanılan STT modeli kimliğini kaydeder (ör. `whisper-medium`). */
  setSttModel(model: string): void {
    const value = String(model || '').trim();
    if (value) this.stageMarks.sttModel = value;
  }

  /** STT transkriptinin karakter uzunluğunu kaydeder. */
  setSttChars(chars: number): void {
    if (Number.isFinite(chars) && chars >= 0) this.stageMarks.sttChars = Math.round(chars);
  }

  /** Seslendirilen yanıtın karakter uzunluğunu kaydeder. */
  setReplyChars(chars: number): void {
    if (Number.isFinite(chars) && chars >= 0) this.stageMarks.replyChars = Math.round(chars);
  }

  /** Bir MCP aracı çağrısını tur bağlamına ekler (sayı + sunucu adı). */
  addMcpTool(toolName: string): void {
    this.stageMarks.mcpToolCount += 1;
    const server = String(toolName.split('.')[0] || '').trim();
    if (server && !this.stageMarks.mcpServers.includes(server)) {
      this.stageMarks.mcpServers.push(server);
    }
  }

  /**
   * LLM ilk-token gecikmesini yazar.
   *
   * Akışsız yolda ilk token ancak yanıtın tamamıyla gelir; pipeline bu
   * durumda `llmMs` değerini geçirir (bkz. `TurnLatency.llmFirstTokenMs`).
   */
  setLlmFirstToken(ms: number): void {
    if (Number.isFinite(ms) && ms >= 0) this.stageMarks.llmFirstTokenMs = Math.round(ms);
  }

  /**
   * TTS zamanlamasını yazar.
   *
   * @param firstChunkMs Sentez isteği → ilk PCM (kullanıcının beklediği).
   * @param totalMs      Sentez isteği → son PCM (sentezin tamamı).
   */
  setTtsTiming(firstChunkMs: number, totalMs: number): void {
    if (Number.isFinite(firstChunkMs) && firstChunkMs >= 0) {
      this.stageMarks.ttsFirstChunkMs = Math.round(firstChunkMs);
    }
    if (Number.isFinite(totalMs) && totalMs >= 0) {
      this.stageMarks.ttsMs = Math.round(totalMs);
    }
  }

  /** Çalma süresini yazar (ilk PCM → kuyruk boşaldı). */
  setPlaybackTime(ms: number): void {
    if (Number.isFinite(ms) && ms >= 0) this.stageMarks.playbackMs = Math.round(ms);
  }

  // ------------------------------------------------------------ sohbet geçmişi

  /** Son sohbet mesajları (kopya). */
  getConversation(): ConversationEntry[] {
    return this.displayHistory.map((entry) => ({ ...entry }));
  }

  /**
   * Sohbet geçmişine mesaj ekler ve `conversation-update` olayını yayınlar.
   *
   * Aynı metinle çift kayıt olmaması için çağıran taraf (pipeline) mesaj
   * ekleme noktalarını tekilleştirir; burada yalnızca kuyruk yönetilir.
   */
  appendConversation(
    entry: Omit<ConversationEntry, 'id' | 'at'> & { at?: number; id?: string }
  ): ConversationEntry {
    this.conversationSeq += 1;
    const record: ConversationEntry = {
      id: entry.id ?? `c${this.conversationSeq}`,
      role: entry.role,
      text: entry.text,
      at: entry.at ?? Date.now(),
      source: entry.source,
      ...(typeof entry.latencyMs === 'number' ? { latencyMs: entry.latencyMs } : {}),
    };
    this.displayHistory.push(record);
    if (this.displayHistory.length > CONVERSATION_LIMIT) {
      this.displayHistory = this.displayHistory.slice(-CONVERSATION_LIMIT);
    }
    this.emit('event', {
      type: 'conversation-update',
      conversation: this.getConversation(),
    } satisfies TelemetryEvent);
    return record;
  }

  /**
   * Son asistan mesajına tur gecikmesini işler (yanıt hazır olduktan sonra
   * ölçüm kesinleştiğinde çağrılır) ve güncel listeyi yayınlar.
   */
  attachLatencyToLastAssistant(latencyMs: number): void {
    for (let i = this.displayHistory.length - 1; i >= 0; i -= 1) {
      const item = this.displayHistory[i];
      if (item.role === 'assistant') {
        item.latencyMs = Math.round(latencyMs);
        break;
      }
    }
    this.emit('event', {
      type: 'conversation-update',
      conversation: this.getConversation(),
    } satisfies TelemetryEvent);
  }

  /**
   * Turu kapatır ve `turn-latency` olayını yayınlar.
   *
   * @param firstAudioAt İlk PCM parçasının hoparlöre yazıldığı an. `null` ise
   *   ses hiç çıkmadı (TTS kapalı ya da hata) → yanıt metninin hazır olduğu an
   *   kullanılır.
   * @param ttsEnabled  Tur sırasında seslendirme açık mıydı?
   * @param token       Kapatılan turun kimliği. Verilirse ve geçerli turdan
   *   farklıysa yayın YAPILMAZ (gecikmiş `finally` başka turun ölçümünü bozmaz).
   */
  finishTurn(
    firstAudioAt: number | null,
    ttsEnabled: boolean,
    token?: number
  ): TurnLatency | null {
    if (token !== undefined && token !== this.turnToken) return null;
    const start = this.stageMarks.turnStart;
    if (!start) return null;

    const end = firstAudioAt ?? Date.now();
    const totalMs = Math.max(0, Math.round(end - start));
    // Savunma: geçersiz (0 veya aşırı küçük) bir ölçüm yayınlanmaz — panelde
    // "0,00 sn" göstermek yerine önceki gerçek değer kalır.
    if (totalMs <= 0) return null;

    const m = this.stageMarks;
    const latency: TurnLatency = {
      totalMs,
      vadMs: m.vadMs,
      sttMs: m.sttMs,
      sttPreprocessMs: m.sttPreprocessMs,
      sttPostprocessMs: m.sttPostprocessMs,
      sttFixes: m.sttFixes,
      sttModel: m.sttModel,
      llmMs: m.llmMs,
      // Akışsız yol: ilk token yanıtın tamamıyla gelir → `llmMs` ile aynı.
      llmFirstTokenMs: m.llmFirstTokenMs > 0 ? m.llmFirstTokenMs : m.llmMs,
      mcpMs: m.mcpMs,
      ttsFirstChunkMs: ttsEnabled ? m.ttsFirstChunkMs : 0,
      ttsMs: ttsEnabled ? m.ttsMs : 0,
      playbackMs: ttsEnabled ? m.playbackMs : 0,
      firstAudioMs: totalMs,
      ttsEnabled,
      mcpToolCount: m.mcpToolCount,
      mcpServers: [...m.mcpServers],
      sttChars: m.sttChars,
      replyChars: m.replyChars,
      llmModel: m.llmModel,
      measuredAt: Date.now(),
    };

    this.lastTurnLatency = latency;
    this.stageMarks = emptyMarks();

    this.log(
      'info',
      'agent',
      `tur süresi ${(totalMs / 1000).toFixed(2)} sn ` +
        `(VAD ${(latency.vadMs / 1000).toFixed(2)} · STT ${(latency.sttMs / 1000).toFixed(2)} · ` +
        `LLM ${(latency.llmMs / 1000).toFixed(2)} · MCP ${(latency.mcpMs / 1000).toFixed(2)} · ` +
        `TTS ${(latency.ttsMs / 1000).toFixed(2)} · ÇALMA ${(latency.playbackMs / 1000).toFixed(2)})` +
        (ttsEnabled ? '' : ' — TTS kapalı')
    );

    this.emit('event', { type: 'turn-latency', latency } satisfies TelemetryEvent);
    return latency;
  }

  /**
   * Turu iptal eder (barge-in / hata). Yarım kalan ölçüm yayınlanmaz;
   * son başarılı tur değeri panelde kalır.
   */
  abortTurn(): void {
    this.turnToken += 1;
    this.stageMarks = emptyMarks();
    this.tTurnStart = 0;
  }

  /** STT çağrısı başlıyor (gecikme ölçümü için). */
  sttStart(): void {
    this.tSttStart = Date.now();
    this.update('stt', 'active', 'segment çözümleniyor…');
  }

  /**
   * STT bitti.
   *
   * `info` opsiyoneldir: eski çağıranlar (yalnızca metin geçen) bozulmadan
   * çalışır. Model kimliği SABİT DEĞİLDİR — hangi Whisper modeli yüklüyse
   * (medium/small/base) panelde o görünür. Sabit "whisper-small" yazmak
   * medium yüklüyken yanıltıcıydı.
   */
  sttDone(
    text: string,
    info?: { model?: string; preprocessMs?: number; postprocessMs?: number; fixes?: number }
  ): void {
    const ms = this.tSttStart ? Date.now() - this.tSttStart : 0;
    const clean = text.trim();
    const metrics: Record<string, string | number> = {
      sure: `${ms} ms`,
      karakter: clean.length,
    };
    if (info?.model) metrics.model = info.model;
    if (info?.preprocessMs) metrics['ön işleme'] = `${Math.round(info.preprocessMs)} ms`;
    if (info?.postprocessMs) metrics['düzeltme'] = `${Math.round(info.postprocessMs)} ms`;
    if (info?.fixes) metrics.düzeltme_sayısı = info.fixes;

    this.update(
      'stt',
      clean ? 'ready' : 'warn',
      clean ? `"${truncate(clean, 90)}"` : 'boş transkript',
      metrics
    );
    if (clean) {
      this.log('info', 'stt', `duyulan: ${truncate(clean, 120)} (${ms} ms)`);
    } else {
      this.log('warn', 'stt', 'transkript boş döndü — sessizlik/gürültü segmenti');
    }
  }

  /** Mikrofon parçası geldi (VAD öncesi). */
  vadChunk(isSpeech: boolean, confidence: number, audioLevel?: number): void {
    const prev = this.stages.get('vad');
    const prob = Math.round(confidence * 100);
    const detail = isSpeech
      ? `konuşma algılandı (güven %${prob})`
      : `sessizlik (güven %${prob})`;
    this.update('vad', isSpeech ? 'active' : 'idle', detail, {
      ...(prev?.metrics ?? {}),
      güven: `%${prob}`,
      seviye: audioLevel !== undefined ? audioLevel.toFixed(3) : '-',
      eşik: '0.50',
    });
  }

  /**
   * Pipeline olaylarını aşama durumuna çevirir.
   * `VoicePipeline.emit()` her olayda çağırır — arayüz bağlı olmasa da
   * telemetri güncellenir (sonradan bağlanan panel anlık durumu görür).
   */
  ingestPipelineEvent(type: string, data: unknown): void {
    const d = (data ?? {}) as Record<string, unknown>;
    const now = Date.now();

    switch (type) {
      case 'state-change': {
        const st = (d.state ?? {}) as Record<string, unknown>;
        if (st.isListening === false && st.isProcessing === true) {
          this.update('mic', 'ready', 'mikrofon açık — işleme devam ediyor');
        }
        break;
      }
      case 'vad-speech-start':
        this.tTurnStart = now;
        this.update('vad', 'active', 'konuşma başladı', {
          güven: `%${Math.round(((d.confidence as number) ?? 1) * 100)}`,
          seviye: typeof d.audioLevel === 'number' ? d.audioLevel.toFixed(3) : '-',
        });
        this.log('info', 'vad', 'konuşma başladı');
        break;
      case 'vad-speech-end':
        this.update('vad', 'ready', `sessizlik ${Math.round(((d.silenceMs as number) ?? 0))} ms — segment kapatıldı`);
        this.log('info', 'vad', `konuşma bitti (sessizlik ${Math.round(((d.silenceMs as number) ?? 0))} ms)`);
        break;
      case 'stt-partial':
        this.update('stt', 'active', `"${truncate(String(d.text ?? ''), 90)}"`);
        break;
      case 'stt-final':
        this.sttDone(String(d.text ?? ''));
        break;
      case 'turn-detected': {
        this.tLlmStart = now;
        this.tLlmFirst = 0;
        this.update('llm', 'active', 'istek gönderildi — yanıt bekleniyor…', {
          model: 'agent',
          istek: truncate(String(d.text ?? ''), 60),
        });
        this.log('info', 'llm', `tur işleniyor: ${truncate(String(d.text ?? ''), 80)}`);
        break;
      }
      case 'llm-streaming': {
        if (!this.tLlmFirst) {
          this.tLlmFirst = now;
          this.log('info', 'llm', `ilk token ${now - this.tLlmStart} ms`);
        }
        const chars = String(d.accumulated ?? d.text ?? '').length;
        this.update('llm', 'active', 'yanıt akıyor…', {
          model: 'agent',
          'ilk token': `${now - this.tLlmStart} ms`,
          karakter: chars,
        });
        break;
      }
      case 'llm-complete': {
        const response = String(d.response ?? '');
        const total = this.tLlmStart ? now - this.tLlmStart : 0;
        this.update('llm', 'ready', `yanıt hazır (${response.length} karakter)`, {
          model: 'agent',
          'ilk token': this.tLlmFirst ? `${this.tLlmFirst - this.tLlmStart} ms` : '-',
          toplam: `${total} ms`,
          karakter: response.length,
        });
        this.log('info', 'llm', `yanıt tamam (${total} ms, ${response.length} karakter)`);
        // TTS kapalıyken yanıtın tek görünür yeri panel: metni olay akışına yaz.
        if (response) {
          this.log('info', 'llm', `yanıt: ${truncate(response, 400)}`);
        }
        break;
      }
      case 'tts-speaking': {
        const buf = d.audioBuffer as Buffer | undefined;
        if (!this.tTtsStart) {
          this.tTtsStart = now;
          this.tTtsFirst = 0;
          this.ttsBytes = 0;
        }
        if (buf && buf.length) {
          if (!this.tTtsFirst) {
            this.tTtsFirst = now;
            this.log('info', 'tts', `ilk ses ${now - this.tTtsStart} ms`);
          }
          this.ttsBytes += buf.length;
          this.update('tts', 'active', 'ses üretiliyor…', {
            ses: 'EMA Lightning',
            'ilk ses': this.tTtsFirst ? `${this.tTtsFirst - this.tTtsStart} ms` : '-',
            bayt: this.ttsBytes,
            saniye: (this.ttsBytes / 32000).toFixed(1),
          });
          this.update('playback', 'active', 'hoparlöre yazılıyor', {
            bayt: this.ttsBytes,
          });
        } else {
          this.update('tts', 'active', 'sentezleniyor…', { ses: 'EMA Lightning' });
        }
        break;
      }
      case 'tts-complete': {
        const total = this.tTtsStart ? now - this.tTtsStart : 0;
        this.update('tts', 'ready', `ses üretildi (${(this.ttsBytes / 32000).toFixed(1)} sn)`, {
          ses: 'EMA Lightning',
          toplam: `${total} ms`,
          bayt: this.ttsBytes,
        });
        this.update('playback', 'ready', 'çalma tamamlandı', { bayt: this.ttsBytes });
        this.log('info', 'tts', `ses tamam (${total} ms, ${(this.ttsBytes / 32000).toFixed(1)} sn)`);
        this.tTtsStart = 0;
        break;
      }
      case 'tts-toggle': {
        // Kullanıcı tray/arayüzden sesi açıp kapattı. Panel satırı da
        // gerçek anahtarı göstermeli; ayrıca tray onay kutusu bu olayla
        // senkronlanır (SSE üzerinden main sürece gider).
        const enabled = d.enabled === true;
        if (enabled) {
          this.update('tts', 'ready', 'TTS açık', { durum: 'açık' });
          this.log('info', 'tts', 'TTS açıldı (çalışma zamanı)');
        } else {
          this.update('tts', 'idle', 'TTS kapalı — ses üretmiyor', { durum: 'kapalı' });
          this.update('playback', 'idle', 'TTS kapalı');
          this.log('info', 'tts', 'TTS kapatıldı (çalışma zamanı)');
        }
        this.emit('event', { type: 'tts-toggle', enabled } satisfies TelemetryEvent);
        break;
      }
      case 'mcp-call':
        this.update('mcp', 'active', `araç çağrısı: ${String(d.tool ?? '')}`, {
          araç: String(d.tool ?? ''),
        });
        this.log('info', 'mcp', `▸ ${String(d.tool ?? 'araç')}`);
        break;
      case 'mcp-complete':
        this.update('mcp', 'ready', 'araç tamamlandı', { araç: String(d.tool ?? '') });
        break;
      case 'barge-in':
        // Barge-in turu iptal eder: LLM akışı, TTS sentezi ve oynatma aynı
        // anda durur. YALNIZCA `playback` kapatılırsa `tts`/`llm` aşamaları
        // `active` kalıyor ve arayüzde "KONUŞUYOR" yazısı ile "Sesi kes"
        // düğmesi kalıcı olarak takılı görünüyordu (canlı doğrulamada
        // yakalandı). Bu yüzden ilgili tüm aşamalar birlikte kapatılır.
        this.update('llm', 'ready', 'yanıt kesildi (barge-in)');
        this.update('tts', 'ready', 'sentez kesildi (barge-in)');
        this.update('playback', 'idle', 'ses kesildi (barge-in)');
        this.tTtsStart = 0;
        this.tTtsFirst = 0;
        this.log('warn', 'playback', 'barge-in: çalan ses kesildi');
        break;
      case 'error': {
        const msg = String(d.error ?? 'bilinmeyen hata');
        const suspect = this.guessStage(msg);
        this.update(suspect, 'error', msg, {});
        this.log('error', suspect, msg);
        break;
      }
      default:
        break;
    }
  }

  /** Hata mesajından sorumlu aşamayı tahmin eder (panelde doğru satırı kırmızı yapar). */
  private guessStage(msg: string): StageKey {
    const m = msg.toLowerCase();
    if (m.includes('mikrofon') || m.includes('arecord') || m.includes('alsa')) return 'mic';
    if (m.includes('vad')) return 'vad';
    if (m.includes('stt') || m.includes('whisper') || m.includes('transkrip')) return 'stt';
    if (m.includes('tts') || m.includes('sentez') || m.includes('ema')) return 'tts';
    if (m.includes('hoparl') || m.includes('aplay')) return 'playback';
    if (m.includes('llm') || m.includes('model') || m.includes('openai')) return 'llm';
    if (m.includes('mcp') || m.includes('araç')) return 'mcp';
    return 'agent';
  }
}

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Süreç genelinde tek telemetri örneği. */
export const telemetry = new Telemetry();
