/**
 * Diji ajan köprüsü için tek React kancası.
 *
 * Sorumluluklar:
 *  - `window.diji.getState()` ile ilk tam durumu çekmek,
 *  - `onTelemetry` / `onConnection` aboneliklerini kurmak ve unmount'ta
 *    dönen kaldırma fonksiyonlarıyla temizlemek (sızıntı yok),
 *  - SSE olaylarını (`snapshot`, `stage`, `conversation-update`,
 *    `turn-latency`, `tts-toggle`) parçalı olarak state'e işlemek,
 *  - tarayıcıda (`window.diji === undefined`) no-op davranmak.
 *
 * Not: Sahte animasyon / `Math.random()` YOKTUR. `micLevel` yalnızca ajanın
 * yayınladığı gerçek `acRms` değerinden (yoksa `mic` aşaması `seviye`
 * metriğinden) türetilir; değer 0 ise 0 görünür.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ConnectionStatus,
  ConversationItem,
  DijiAPI,
  LogLine,
  McpServerStatus,
  ModelCatalog,
  ModelKind,
  ModelSelectResult,
  PendingConfirmation,
  Stage,
  StatePayload,
  TelemetryEvent,
  TurnLatency,
} from "@/types/diji";

/** Ekranda tutulacak azami olay akışı satırı. */
const MAX_LOG_LINES = 60;

/** `acRms` → 0..1 normalize ölçeği (ajan RMS'i ~0.4–0.7 aralığında yayınlıyor). */
const LEVEL_CEILING = 0.6;

/** Köprüye güvenli erişim; tarayıcıda `undefined`. */
function getBridge(): DijiAPI | undefined {
  if (typeof window === "undefined") return undefined;
  return window.diji;
}

/** Gerçek RMS değerini 0..1 aralığına sıkıştırır. */
function normalizeLevel(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(1, Math.max(0, numeric / LEVEL_CEILING));
}

/** Aşama dizisini `key` anahtarlı sözlüğe çevirir. */
function toStageMap(stages: Stage[] | undefined): Record<string, Stage> {
  const map: Record<string, Stage> = {};
  for (const stage of stages ?? []) {
    if (!stage || typeof stage.key !== "string") continue;
    map[stage.key] = stage;
  }
  return map;
}

/** Olay akışını sona doğru budar (en yeni kayıtlar kalır). */
function trimLogs(lines: LogLine[]): LogLine[] {
  return lines.length > MAX_LOG_LINES ? lines.slice(lines.length - MAX_LOG_LINES) : lines;
}

export interface UseAgentResult {
  /** SSE bağlantısı canlı mı (`onConnection`). */
  connected: boolean;
  /** Köprü bu pencerede mevcut mu (Electron). */
  available: boolean;
  /** Son bilinen tam durum. */
  state: StatePayload | null;
  /** `stageOrder` bazlı aşama sözlüğü: `agent` | `mic` | `vad` | … */
  stages: Record<string, Stage>;
  /** Son 60 olay akışı satırı. */
  logs: LogLine[];
  /** Ajan sohbet geçmişi (tek akış, en fazla `conversationLimit`). */
  conversation: ConversationItem[];
  /** Son tur gecikmesi. */
  lastTurnLatency: TurnLatency | null;
  /** TTS motoru açık mı. */
  ttsEnabled: boolean;
  /** 0..1 arası gerçek mikrofon seviyesi. */
  micLevel: number;
  isListening: boolean;
  isSpeaking: boolean;
  isProcessing: boolean;
  /** Onay bekleyen MCP işlemi (yoksa `null`). */
  pendingConfirmation: PendingConfirmation | null;
  /** MCP sunucularının canlı durumu (`/state.mcpServers`). */
  mcpServers: McpServerStatus[];
  /** Ayarlar ekranının model listeleri; Ayarlar paneli açılınca yüklenir. */
  modelCatalog: ModelCatalog | null;
  /** Model kataloğu şu an yükleniyor mu. */
  modelsLoading: boolean;
  /** Model değişimi sürüyor mu (uzun geçişlerde arayüz göstergesi). */
  modelSwitching: ModelKind | null;
  /** Kataloğu (yeniden) çeker. */
  loadModels: () => Promise<ModelCatalog | null>;
  /** Model değiştirir; başarılıysa `ok:true` döner ve katalog tazelenir. */
  selectModel: (kind: ModelKind, id: string) => Promise<ModelSelectResult>;
  /** Metin sorusu gönderir (yanıt metni SSE'den gelir). */
  ask: (text: string) => Promise<void>;
  /** Ajan mikrofonunu aç/kapat. */
  toggleListen: () => Promise<void>;
  /** TTS motorunu aç/kapat. */
  toggleTts: () => Promise<void>;
  /** Onay bekleyen MCP işlemini onaylar/reddeder. */
  confirm: (approved: boolean) => Promise<boolean>;
  /** Devam eden konuşmayı/oynatmayı kes. */
  bargeIn: () => Promise<void>;
}

export function useAgent(): UseAgentResult {
  const bridgeRef = useRef<DijiAPI | undefined>(getBridge());
  const [available] = useState<boolean>(() => Boolean(getBridge()));
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<StatePayload | null>(null);
  const [stageMap, setStageMap] = useState<Record<string, Stage>>({});
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [conversation, setConversation] = useState<ConversationItem[]>([]);
  const [lastTurnLatency, setLastTurnLatency] = useState<TurnLatency | null>(null);
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([]);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelSwitching, setModelSwitching] = useState<ModelKind | null>(null);
  const mountedRef = useRef(true);

  /** Tam durumu tüm türetilmiş dilimlere uygular. */
  const applySnapshot = useCallback((payload: StatePayload | null | undefined) => {
    if (!payload || typeof payload !== "object") return;
    setState(payload);
    setStageMap(toStageMap(payload.stages));
    setLogs(trimLogs(Array.isArray(payload.log) ? payload.log : []));
    setConversation(Array.isArray(payload.conversation) ? payload.conversation : []);
    setLastTurnLatency(payload.lastTurnLatency ?? null);
    if (typeof payload.ttsEnabled === "boolean") setTtsEnabled(payload.ttsEnabled);
    // Onay durumu ve MCP sunucuları yalnızca snapshot/getState ile gelir;
    // canlı değişim ayrıca `confirmation` olayıyla da yakalanır.
    setPendingConfirmation(payload.pendingConfirmation ?? null);
    setMcpServers(Array.isArray(payload.mcpServers) ? payload.mcpServers : []);
  }, []);

  /** Tek seferlik durum tazeleme (kullanıcı eylemi sonrası senkron). */
  const syncState = useCallback(async () => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    try {
      const payload = await bridge.getState();
      if (!mountedRef.current) return;
      if (payload && payload.ok === false) {
        setConnected(false);
        return;
      }
      applySnapshot(payload);
      setConnected(true);
    } catch {
      if (mountedRef.current) setConnected(false);
    }
  }, [applySnapshot]);

  useEffect(() => {
    mountedRef.current = true;
    const bridge = bridgeRef.current;
    if (!bridge) return;

    let disposed = false;

    void bridge
      .getState()
      .then((payload) => {
        if (disposed) return;
        if (payload && payload.ok === false) return;
        applySnapshot(payload);
        setConnected(true);
      })
      .catch(() => {
        /* Ajan henüz hazır değil; SSE snapshot geldiğinde dolacak. */
      });

    const offTelemetry = bridge.onTelemetry((event: TelemetryEvent) => {
      if (disposed || !event || typeof event !== "object") return;
      // `snapshot` olayında `type` alanı YOK; gövdenin kendisi tam durumdur.
      if (!("type" in event) || (event as { type?: unknown }).type === undefined) {
        applySnapshot(event as unknown as StatePayload);
        return;
      }
      switch (event.type) {
        case "snapshot": {
          applySnapshot(event.state ?? (event as unknown as StatePayload));
          break;
        }
        case "stage": {
          const next = event.state;
          if (!next || typeof next.key !== "string") return;
          setStageMap((current) => ({ ...current, [next.key]: next }));
          // Tüm state'i ezme: yalnızca ilgili aşamayı birleştir.
          setState((current) => {
            if (!current) return current;
            const merged = toStageMap(current.stages);
            merged[next.key] = next;
            const order = current.stageOrder ?? Object.keys(merged);
            const stages = order
              .map((key) => merged[key])
              .filter((stage): stage is Stage => Boolean(stage));
            return { ...current, stages };
          });
          break;
        }
        case "log": {
          if (!event.entry) return;
          setLogs((current) => trimLogs([...current, event.entry]));
          break;
        }
        case "conversation-update": {
          if (Array.isArray(event.conversation)) setConversation(event.conversation);
          break;
        }
        case "turn-latency": {
          if (event.latency) {
            setLastTurnLatency(event.latency);
            setState((current) => (current ? { ...current, lastTurnLatency: event.latency } : current));
          }
          break;
        }
        case "tts-toggle": {
          if (typeof event.enabled === "boolean") {
            setTtsEnabled(event.enabled);
            setState((current) => (current ? { ...current, ttsEnabled: event.enabled } : current));
          }
          break;
        }
        case "confirmation": {
          // Ajan onay istedi / onay-ret-zaman aşımı ile kapattı.
          setPendingConfirmation(event.pending ?? null);
          setState((current) =>
            current ? { ...current, pendingConfirmation: event.pending ?? null } : current
          );
          break;
        }
        default:
          break;
      }
    });

    const offConnection = bridge.onConnection((status: ConnectionStatus) => {
      if (disposed || !status) return;
      setConnected(Boolean(status.connected));
      // Yeniden bağlanma sonrası durum bayat kalmasın.
      if (status.connected) void syncState();
    });

    return () => {
      disposed = true;
      mountedRef.current = false;
      offTelemetry();
      offConnection();
    };
  }, [applySnapshot, syncState]);

  const stages = useMemo(() => stageMap, [stageMap]);

  /**
   * Dinleme durumu için GERÇEK kaynak.
   *
   * Ölçüldü (ajan 8899): `POST /listen {enabled:false}` sonrası
   * `pipeline.state.isListening` bayrağı **bayat** kalıyor (true dönmeye devam
   * ediyor) ve `pipeline.audio` null oluyor. Gerçek sinyal iki yerde:
   *   1) `stages.mic.status === "active"` (veya detail'inde "dinleniyor")
   *   2) `pipeline.audio.running` (durdurulunca null/false)
   * `isListening` yalnızca mic aşaması yoksa (eski ajan) yedek olarak kullanılır.
   */
  const micStage = stageMap["mic"];
  const isListening = useMemo(() => {
    // Önce canlı aşama: `stage` olayları saniyede ~2 kez gelir.
    if (micStage) {
      if (micStage.status === "active") return true;
      if (micStage.status === "idle" || micStage.status === "error") return false;
      return (micStage.detail ?? "").toLowerCase().includes("dinleniyor");
    }
    // `pipeline.audio` yalnızca snapshot/getState ile gelir; `stage` olayları
    // onu güncellemediği için burada BAYAT olabilir — bu yüzden yalnızca
    // mic aşaması hiç yoksa kullanılır.
    const audioRunning = state?.pipeline?.audio?.running;
    if (audioRunning === true) return true;
    if (audioRunning === false) return false;
    return Boolean(state?.pipeline?.state?.isListening);
  }, [micStage, state?.pipeline?.audio?.running, state?.pipeline?.state?.isListening]);

  const ask = useCallback(async (text: string) => {
    const bridge = bridgeRef.current;
    const clean = text.trim();
    if (!bridge || !clean) return;
    try {
      await bridge.ask(clean);
    } catch {
      /* Sohbet akışı SSE'den gelir; ağ hatası UI'yı kilitlememeli. */
    }
  }, []);

  const toggleListen = useCallback(async () => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    // Hedef, `state.pipeline.state.isListening` (bayat olabilir) DEĞİL,
    // arayüzün gösterdiği gerçek dinleme durumudur.
    const target = !isListening;
    try {
      await bridge.listen(target);
    } catch {
      /* yut: arayüz durumu SSE/getState ile düzelir */
    }
    // Ajan `/listen` sonrası durumu gecikmeli yayınlıyor; eylem başına
    // iki kısa senkronla (polling değil) gerçek durumu yakala.
    await syncState();
    setTimeout(() => {
      if (mountedRef.current) void syncState();
    }, 900);
  }, [isListening, syncState]);

  const toggleTts = useCallback(async () => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    const target = !ttsEnabled;
    try {
      const result = await bridge.setTts(target);
      if (result && typeof result.enabled === "boolean") {
        setTtsEnabled(result.enabled);
      } else {
        await syncState();
      }
    } catch {
      /* yut */
    }
  }, [ttsEnabled, syncState]);

  /**
   * Onay bekleyen MCP işlemini sonuçlandırır.
   *
   * Ajan `/confirm` uç noktası `confirmed` alanını bekler (`approved` DEĞİL);
   * yanlış alan sessizce `applied:false` üretirdi. İyimser davranmıyoruz:
   * diyalog yalnızca ajan `confirmation` olayıyla kapatınca kapanır.
   *
   * @returns İşlem gerçekten uygulandıysa `true`.
   */
  const confirm = useCallback(async (approved: boolean): Promise<boolean> => {
    const bridge = bridgeRef.current;
    if (!bridge) return false;
    try {
      const result = await bridge.confirm(approved);
      if (result && typeof result.applied === "boolean" && result.applied) {
        setPendingConfirmation(null);
        return true;
      }
      // Bekleyen onay yoksa (zaman aşımı) sunucu `applied:false` döner;
      // diyaloğu yine de kapat ki kullanıcı kilitli kalmasın.
      setPendingConfirmation(null);
      await syncState();
      return false;
    } catch {
      await syncState();
      return false;
    }
  }, [syncState]);

  const bargeIn = useCallback(async () => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    try {
      await bridge.bargeIn();
    } catch {
      /* yut */
    }
  }, []);

  /**
   * Model kataloğunu çeker.
   *
   * Neden tembel: LLM bölümü için ajan yerel model sunucusuna ayrıca istek
   * atar (~2,5 sn). Bu çağrı yalnızca Ayarlar paneli açıldığında yapılır;
   * uygulama açılışını yavaşlatmaz.
   */
  const loadModels = useCallback(async (): Promise<ModelCatalog | null> => {
    const bridge = bridgeRef.current;
    if (!bridge) return null;
    setModelsLoading(true);
    try {
      const catalog = await bridge.getModels();
      if (!mountedRef.current) return null;
      if (catalog && catalog.ok) {
        setModelCatalog(catalog);
        return catalog;
      }
      return null;
    } catch {
      return null;
    } finally {
      if (mountedRef.current) setModelsLoading(false);
    }
  }, []);

  /**
   * Model değiştirir.
   *
   * Başarılıysa katalog TAZELENİR: ajan `current` değerini çalışan motordan
   * okur, dolayısıyla listedeki "seçili" işareti gerçek duruma göre güncellenir
   * (ör. drifting-tts başlatılamayıp sherpa-vits'e düşerse panel bunu gösterir).
   */
  const selectModel = useCallback(
    async (kind: ModelKind, id: string): Promise<ModelSelectResult> => {
      const bridge = bridgeRef.current;
      if (!bridge) return { ok: false, reason: "Ajan köprüsü yok" };
      setModelSwitching(kind);
      try {
        const result = await bridge.selectModel(kind, id);
        if (result?.ok) await loadModels();
        return result ?? { ok: false, reason: "Yanıt alınamadı" };
      } catch (error) {
        return { ok: false, reason: (error as Error).message };
      } finally {
        if (mountedRef.current) setModelSwitching(null);
      }
    },
    [loadModels]
  );


  const micLevel = useMemo(() => {
    // `mic` aşaması gerçek RMS'i saniyede ~2 kez yayınlar (ölçüldü: 22 sn'de 49
    // olay); `pipeline.audio.acRms` ise yalnızca snapshot/getState ile gelir ve
    // olaylar arasında donar. Canlı değer için aşama metriği önceliklidir,
    // yoksa `acRms`'e düşülür. İkisi de aynı ajan RMS'idir — uydurma yok.
    const stageRms = stageMap["mic"]?.metrics?.["seviye"];
    if (stageRms !== undefined && stageRms !== null && stageRms !== "") {
      return normalizeLevel(stageRms);
    }
    const audioRms: unknown = state?.pipeline?.audio?.acRms;
    if (audioRms !== undefined && audioRms !== null) return normalizeLevel(audioRms);
    return 0;
  }, [state?.pipeline?.audio?.acRms, stageMap]);

  /**
   * Ses gerçekten çalıyor mu?
   *
   * `state.pipeline.state.isSpeaking` YALNIZCA snapshot/getState ile gelir;
   * `stage` olayları onu güncellemediği için BAYAT kalır (TTS bitse bile
   * `true` dönebilir). Canlı sinyal `tts` / `playback` aşamalarıdır — bunlar
   * saniyede birkaç kez SSE ile tazelenir. Bayat bayrak yalnızca aşama
   * bilgisi hiç yoksa (eski ajan) yedek olarak kullanılır.
   */
  const isSpeaking = useMemo(() => {
    const ttsStage = stageMap["tts"];
    const playbackStage = stageMap["playback"];
    if (ttsStage || playbackStage) {
      return ttsStage?.status === "active" || playbackStage?.status === "active";
    }
    return Boolean(state?.pipeline?.state?.isSpeaking);
  }, [stageMap, state?.pipeline?.state?.isSpeaking]);

  return {
    connected,
    available,
    state,
    stages,
    logs,
    conversation,
    lastTurnLatency,
    ttsEnabled,
    micLevel,
    isListening,
    isSpeaking,
    isProcessing: Boolean(state?.pipeline?.state?.isProcessing),
    pendingConfirmation,
    mcpServers,
    modelCatalog,
    modelsLoading,
    modelSwitching,
    loadModels,
    selectModel,
    ask,
    toggleListen,
    toggleTts,
    confirm,
    bargeIn,
  };
}
