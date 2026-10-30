'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Mail,
  Calendar,
  Slack,
  Cloud,
  FileText,
  HardDrive,
  Globe,
  Mic,
  Activity,
  Settings,
  Power,
  ArrowLeftRight,
  Volume2,
  VolumeX,
  Send,
  XCircle,
} from 'lucide-react';

interface CapabilityNode {
  id: string;
  label: string;
  icon: React.ElementType;
  color: string;
  active: boolean;
}

const CAPABILITIES: CapabilityNode[] = [
  { id: 'gmail', label: 'Gmail', icon: Mail, color: '#ea4335', active: false },
  { id: 'calendar', label: 'Takvim', icon: Calendar, color: '#34a853', active: false },
  { id: 'slack', label: 'Slack', icon: Slack, color: '#4a154b', active: false },
  { id: 'weather', label: 'Hava', icon: Cloud, color: '#4285f4', active: false },
  { id: 'notion', label: 'Notion', icon: FileText, color: '#000000', active: false },
  { id: 'drive', label: 'Drive', icon: HardDrive, color: '#34a853', active: false },
  { id: 'chrome', label: 'Chrome', icon: Globe, color: '#4285f4', active: false },
];

const STATUS_MESSAGES: Record<string, string> = {
  idle: 'HAZIR',
  listening: 'DİNLEYIYOR',
  processing: 'İŞLENYOR',
  speaking: 'CEVAP VERİYOR',
  weather: 'HAVA DURUMUNA BAKIYOR',
  gmail: 'GMAIL\'E BAKIYOR',
  calendar: 'TAKVİME BAKIYOR',
  slack: 'SLACK\'E BAKIYOR',
  notion: 'NOTION\'A BAKIYOR',
  drive: 'DRIVE\'I TARAYIYOR',
  chrome: 'CHROME\'DA ARAMA YAPIYOR',
  error: 'HATA OLUŞTU',
};

type StatusKey = keyof typeof STATUS_MESSAGES;

// ---------------------------------------------------------------- teşhis tipleri
// Ajanın kontrol sunucusundan (SSE) gelen aşama telemetrisi. Paneldeki her
// satır bu verilerle beslenir; sabit/mock durum yoktur.
type StageKey = 'agent' | 'mic' | 'vad' | 'stt' | 'llm' | 'tts' | 'playback' | 'mcp';
type StageStatus = 'idle' | 'ready' | 'active' | 'warn' | 'error';

interface StageState {
  key: StageKey;
  label: string;
  status: StageStatus;
  detail: string;
  metrics: Record<string, string | number>;
  updatedAt: number;
}

interface LogEntry {
  id: number;
  t: number;
  level: 'info' | 'warn' | 'error';
  stage: StageKey;
  msg: string;
}

/**
 * Bir turun uçtan uca gecikmesi.
 *
 * Ajan `telemetry.TurnLatency` şemasıyla birebir aynıdır. Her `*Ms` alanı o
 * aşamanın KENDİ İÇİNDE geçirdiği süredir; alanların toplamı `totalMs`'e eşit
 * olmak zorunda değildir (VAD ve çalma toplamla örtüşür/uzar).
 */
interface TurnLatency {
  totalMs: number;
  /** Son konuşma karesi → segment kapanışı (VAD kararı). */
  vadMs: number;
  sttMs: number;
  /** Ses temizliği: DC → high-pass → kırpma → gürültü kapısı → AGC. */
  sttPreprocessMs?: number;
  /** Transkript düzeltmesi: halüsinasyon/sözlük/boşluk. */
  sttPostprocessMs?: number;
  /** Bu turda yapılan transkript düzeltmesi sayısı. */
  sttFixes?: number;
  /** Kullanılan STT modeli (ör. `whisper-medium`). */
  sttModel?: string;
  llmMs: number;
  /** Akışsız yolda `llmMs` ile aynıdır (ilk token ancak yanıtla gelir). */
  llmFirstTokenMs: number;
  mcpMs: number;
  /** Sentez isteği → ilk PCM. */
  ttsFirstChunkMs: number;
  /** Sentez isteği → son PCM (sentezin tamamı). */
  ttsMs: number;
  /** İlk PCM → çalma bitişi. */
  playbackMs: number;
  firstAudioMs: number;
  ttsEnabled: boolean;
  mcpToolCount: number;
  mcpServers: string[];
  sttChars: number;
  replyChars: number;
  llmModel: string;
  measuredAt: number;
}

/** Arayüzün sohbet panelinde gösterdiği mesaj (ajan `ConversationEntry`). */
interface ConversationEntry {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: number;
  source: 'voice' | 'text';
  latencyMs?: number;
}

const STAGE_ORDER: StageKey[] = ['agent', 'mic', 'vad', 'stt', 'llm', 'tts', 'playback', 'mcp'];

/**
 * Aşama KUTULARININ gösterim sırası. Boru hattının akış sırası:
 * VAD → STT → LLM → MCP → TTS → ÇALMA.
 */
const CARD_ORDER: StageKey[] = ['agent', 'mic', 'vad', 'stt', 'llm', 'mcp', 'tts', 'playback'];

const STAGE_STATUS_TEXT: Record<StageStatus, string> = {
  idle: 'BEKLİYOR',
  ready: 'HAZIR',
  active: 'AKTİF',
  warn: 'UYARI',
  error: 'HATA',
};

// Olay akışında aşama adlarının kısa karşılıkları
const STAGE_SHORT: Record<StageKey, string> = {
  agent: 'AJAN',
  mic: 'MİK',
  vad: 'VAD',
  stt: 'STT',
  llm: 'LLM',
  tts: 'TTS',
  playback: 'SES',
  mcp: 'MCP',
};

const LOG_LIMIT = 120;

/** Milisaniyeyi Türkçe biçime çevirir: <1000 ms ise `742 ms`, değilse `10,53 sn`. */
function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2).replace('.', ',')} sn`;
}

/** Aşama dökümü için kısa biçim: `0,68 sn` / `742 ms`. */
function formatStageMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0';
  if (ms < 1000) return `${(ms / 1000).toFixed(2).replace('.', ',')}`;
  return `${(ms / 1000).toFixed(1).replace('.', ',')}`;
}

/** Sohbet balonundaki gecikme notu: `2,5 sn` / `740 ms`. */
function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1).replace('.', ',')} sn`;
}

/** Epoch ms → `HH:MM`. */
function formatClock(at: number): string {
  try {
    return new Date(at).toLocaleTimeString('tr-TR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return '--:--';
  }
}

// Window is globally augmented with a 'diji' property of type DijiAPI

export default function DijiPage() {
  const [status, setStatus] = useState<StatusKey>('idle');
  const [isListening, setIsListening] = useState(false);
  const [activeNodes, setActiveNodes] = useState<Set<string>>(new Set());
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- teşhis paneli durumu ----
  const [stages, setStages] = useState<Record<string, StageState>>({});
  const [logLines, setLogLines] = useState<LogEntry[]>([]);
  const [agentConnected, setAgentConnected] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  // TTS açık mı? Ajanın `/state` alanı (`ttsEnabled`) ve `tts-toggle` SSE
  // olayı ile senkronlanır; düğme ajanı yeniden başlatmadan aç/kapat yapar.
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [ttsBusy, setTtsBusy] = useState(false);
  // Son turun uçtan uca gecikmesi. `turn-latency` SSE olayı veya `/state`
  // yanıtı ile dolar; tur bitince kalıcıdır (panel sürekli gösterir).
  const [lastLatency, setLastLatency] = useState<TurnLatency | null>(null);

  // ---- sohbet paneli + metin girişi ----
  // `conversation` ajanın `displayHistory` listesidir (son 50 mesaj).
  // `optimistic` yalnızca gönderim anında eklenen geçici balondur; sunucudan
  // doğrulanmış liste gelince aynı metin bulunup kaldırılır.
  const [conversation, setConversation] = useState<ConversationEntry[]>([]);
  const [optimistic, setOptimistic] = useState<ConversationEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const logBoxRef = useRef<HTMLDivElement | null>(null);
  const chatBoxRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const localLogId = useRef(0);

  // Status message translation
  const statusMessage = useCallback(() => {
    return STATUS_MESSAGES[status] || STATUS_MESSAGES.idle;
  }, [status]);

  // Activate a capability node
  const activateNode = useCallback((nodeId: string) => {
    setActiveNodes((prev) => new Set([...prev, nodeId]));
    window.diji?.activateNode(nodeId);
  }, []);

  // Deactivate a capability node
  const deactivateNode = useCallback((nodeId: string) => {
    setActiveNodes((prev) => {
      const next = new Set(prev);
      next.delete(nodeId);
      return next;
    });
    window.diji?.deactivateNode(nodeId);
  }, []);

  // Handle IPC status updates from Electron agent
  useEffect(() => {
    if (!window.diji) return;

    const unsubscribeStatus = window.diji.onStatusUpdate((newStatus: string) => {
      setStatus((newStatus as unknown) as StatusKey);
    });

    const unsubscribeActivate = window.diji.onNodeActivate((nodeId: string) => {
      activateNode(nodeId);
    });

    const unsubscribeDeactivate = window.diji.onNodeDeactivate((nodeId: string) => {
      deactivateNode(nodeId);
    });

    const unsubscribeVoice = window.diji.onVoiceResponse((response: unknown) => {
      console.log('Voice response:', response);
    });

    return () => {
      unsubscribeStatus();
      unsubscribeActivate();
      unsubscribeDeactivate();
      unsubscribeVoice();
    };
  }, [activateNode, deactivateNode]);

  // Simulate node activation based on status
  useEffect(() => {
    const nodeIdMap: Record<StatusKey, string | null> = {
      idle: null,
      listening: null,
      processing: null,
      speaking: null,
      weather: 'weather',
      gmail: 'gmail',
      calendar: 'calendar',
      slack: 'slack',
      notion: 'notion',
      drive: 'drive',
      chrome: 'chrome',
      error: null,
    };

    const nodeId = nodeIdMap[status];
    if (nodeId) {
      activateNode(nodeId);
      // Auto-deactivate after 3 seconds
      setTimeout(() => deactivateNode(nodeId), 3000);
    } else if (status === 'idle') {
      // Deactivate all nodes when idle
      activeNodes.forEach((id) => deactivateNode(id));
    }
  }, [status, activeNodes, activateNode, deactivateNode]);

  // ---------------------------------------------------------------- teşhis
  const pushLog = useCallback((level: LogEntry['level'], stage: StageKey, msg: string) => {
    localLogId.current += 1;
    const entry: LogEntry = { id: -localLogId.current, t: Date.now(), level, stage, msg };
    setLogLines((prev) => [...prev.slice(-LOG_LIMIT + 1), entry]);
  }, []);

  /** /state yanıtını panele uygular (ilk bağlantı ve yeniden bağlanmada). */
  const applyState = useCallback((data: any) => {
    if (!data) return;
    if (Array.isArray(data.stages)) {
      const next: Record<string, StageState> = {};
      for (const s of data.stages as StageState[]) next[s.key] = s;
      setStages(next);
    }
    if (Array.isArray(data.log)) {
      setLogLines((data.log as LogEntry[]).slice(-LOG_LIMIT));
    }
    // TTS anahtarının GERÇEK değeri (env + çalışma zamanı seçimi).
    if (typeof data.ttsEnabled === 'boolean') {
      setTtsEnabled(data.ttsEnabled);
    }
    // Son turun gecikmesi (ajan `buildState().lastTurnLatency`).
    if (data.lastTurnLatency && typeof data.lastTurnLatency === 'object') {
      setLastLatency(data.lastTurnLatency as TurnLatency);
    }
    // Sohbet geçmişi (ajan `buildState().conversation`, son 50 mesaj).
    if (Array.isArray(data.conversation)) {
      setConversation(data.conversation as ConversationEntry[]);
    }
    const listening = Boolean(data.pipeline?.state?.isListening);
    setIsListening(listening);
    setIsMicMuted(!listening);
  }, []);

  // Ajan telemetrisi: SSE olayları Electron ana süreci üzerinden buraya gelir.
  useEffect(() => {
    if (!window.diji?.onTelemetry) return;

    const unsubscribe = window.diji.onTelemetry((raw: unknown) => {
      const evt = raw as
        | { type: 'link'; connected: boolean }
        | { type: 'stage'; state: StageState }
        | { type: 'snapshot'; data?: unknown }
        | { type: 'log'; entry: LogEntry }
        | { type: 'tts-toggle'; enabled: boolean }
        | { type: 'turn-latency'; latency: TurnLatency }
        | { type: 'conversation-update'; conversation: ConversationEntry[] }
        | Record<string, any>;
      if (!evt || typeof evt !== 'object') return;
      const type = (evt as { type?: string }).type;

      // TTS anahtarı tray'den veya başka bir istemciden değişti: düğmeyi eşitle.
      if (type === 'tts-toggle') {
        const enabled = (evt as { enabled?: boolean }).enabled === true;
        setTtsEnabled(enabled);
        return;
      }

      // Tur tamamlandı: uçtan uca gecikme dökümü (panelin en üst satırı).
      if (type === 'turn-latency') {
        const latency = (evt as { latency?: TurnLatency }).latency;
        if (latency && typeof latency.totalMs === 'number') setLastLatency(latency);
        return;
      }

      // Sohbet geçmişi güncellendi: doğrulanmış liste + optimistik temizliği.
      if (type === 'conversation-update') {
        const list = (evt as { conversation?: ConversationEntry[] }).conversation;
        if (Array.isArray(list)) {
          setConversation(list);
          setOptimistic((prev) =>
            prev.filter(
              (local) => !list.some((m) => m.role === local.role && m.text === local.text)
            )
          );
        }
        return;
      }

      if (type === 'link') {
        const connected = Boolean((evt as { connected?: boolean }).connected);
        setAgentConnected(connected);
        pushLog(
          connected ? 'info' : 'warn',
          'agent',
          connected ? 'ajana bağlandı' : 'ajan bağlantısı koptu'
        );
        if (connected) {
          void window.diji?.agentState().then((res: any) => {
            if (res?.ok) applyState(res.data);
            else pushLog('warn', 'agent', res?.error ?? 'durum alınamadı');
          });
        }
        return;
      }

      if (type === 'stage') {
        const state = (evt as { state: StageState }).state;
        setStages((prev) => ({ ...prev, [state.key]: state }));
        if (state.key === 'mic') {
          const listening = state.status === 'active' || state.status === 'ready';
          setIsListening(listening);
          setIsMicMuted(!listening);
        }
        return;
      }

      if (type === 'log') {
        const entry = (evt as { entry: LogEntry }).entry;
        setLogLines((prev) => [...prev.slice(-LOG_LIMIT + 1), entry]);
        return;
      }

      // SSE 'snapshot' çerçevesi: kontrol sunucusu ilk bağlantıda tam durum yollar.
      if (type === 'snapshot' || (evt as { stages?: unknown }).stages) {
        applyState(evt);
      }
    });

    void window.diji.agentState().then((res: any) => {
      if (res?.ok) {
        setAgentConnected(true);
        applyState(res.data);
      } else {
        setAgentConnected(false);
        pushLog('warn', 'agent', res?.error ?? 'ajana ulaşılamadı');
      }
    });

    return () => unsubscribe();
  }, [applyState, pushLog]);

  // Olay akışını en alta sabitle
  useEffect(() => {
    const box = logBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [logLines]);

  // Sohbeti en alta sabitle (yeni mesaj geldiğinde).
  const visibleConversation = [...conversation, ...optimistic];
  useEffect(() => {
    const box = chatBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [visibleConversation.length]);

  // Handle microphone toggle — gerçek ajanı kontrol eder
  const toggleMic = useCallback(async () => {
    if (busy) return;
    const next = !isListening;
    setBusy(true);
    try {
      const res: any = await window.diji?.agentListen(next);
      if (!res) {
        setError('Ajan köprüsü yok (tarayıcıda çalışıyor olabilir)');
        return;
      }
      if (res.ok) {
        setIsListening(next);
        setIsMicMuted(!next);
        setStatus(next ? 'listening' : 'idle');
        // Ajan tarafı da aynı olayı günlüğe yazıyor; burada tekrar eklenmiyor.
      } else {
        setError(res.error ?? 'dinleme isteği başarısız');
        pushLog('error', 'mic', res.error ?? 'dinleme isteği başarısız');
        const state: any = await window.diji?.agentState();
        setAgentConnected(Boolean(state?.ok));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [busy, isListening, pushLog]);

  /**
   * TTS aç/kapat — ajanı YENİDEN BAŞLATMADAN.
   *
   * `agentTts` → IPC → ajan `POST /tts` → `pipeline.setTtsEnabled()`.
   * Ajan `tts-toggle` olayını yayınlar; hem bu düğme (SSE) hem tray onay
   * kutusu aynı olayla senkronlanır.
   */
  const toggleTts = useCallback(async () => {
    if (ttsBusy) return;
    const next = !ttsEnabled;
    setTtsBusy(true);
    try {
      const res: any = await window.diji?.agentTts(next);
      if (!res) {
        setError('Ajan köprüsü yok (tarayıcıda çalışıyor olabilir)');
        return;
      }
      if (res.ok) {
        setTtsEnabled(Boolean(res.enabled));
        pushLog('info', 'tts', res.enabled ? 'TTS açıldı' : 'TTS kapatıldı');
      } else {
        setError(res.error ?? 'TTS isteği başarısız');
        pushLog('error', 'tts', res.error ?? 'TTS isteği başarısız');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTtsBusy(false);
    }
  }, [ttsBusy, ttsEnabled, pushLog]);

  /**
   * Metin girişinden mesaj gönderir (`POST /ask`).
   *
   * Optimistik: kullanıcı balonu HEMEN listeye düşer; ajan
   * `conversation-update` yayınladığında doğrulanmış liste gelir ve geçici
   * balon aynı metinle eşleşip kaldırılır.
   */
  const sendMessage = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;

    setSending(true);
    setDraft('');

    const local: ConversationEntry = {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      role: 'user',
      text,
      at: Date.now(),
      source: 'text',
    };
    setOptimistic((prev) => [...prev, local]);

    // Emniyet kemeri: ajan turu reddederse (ör. `isProcessing` kilidi) hiçbir
    // `conversation-update` gelmez ve optimistik balon sonsuza kadar kalırdı.
    // 25 sn sonra yanıtsız yerel balon sessizce kaldırılır.
    const watchdog = window.setTimeout(() => {
      setOptimistic((prev) => prev.filter((m) => m.id !== local.id));
    }, 25000);

    try {
      const res: any = await window.diji?.agentAsk(text);
      if (!res) {
        setError('Ajan köprüsü yok (tarayıcıda çalışıyor olabilir)');
        pushLog('error', 'agent', 'metin isteği gönderilemedi (köprü yok)');
        setOptimistic((prev) => prev.filter((m) => m.id !== local.id));
        return;
      }
      if (res.ok !== true) {
        const msg = res.error ?? 'metin isteği başarısız';
        setError(msg);
        pushLog('error', 'agent', msg);
        setOptimistic((prev) => prev.filter((m) => m.id !== local.id));
      }
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      pushLog('error', 'agent', msg);
      setOptimistic((prev) => prev.filter((m) => m.id !== local.id));
    } finally {
      window.clearTimeout(watchdog);
      setSending(false);
      // Odak korunur: kullanıcı arka arkaya yazabilsin.
      requestAnimationFrame(() => composerRef.current?.focus());
    }
  }, [draft, sending, pushLog]);

  // Teşhis: ilk tıkanan aşama (panel başlığındaki uyarı satırı)
  const bottleneck = (() => {
    if (!agentConnected) return 'Ajan bağlı değil — otomatik yeniden deneniyor…';
    for (const key of STAGE_ORDER) {
      const s = stages[key];
      if (s?.status === 'error') return `${s.label}: ${s.detail}`;
    }
    for (const key of STAGE_ORDER) {
      const s = stages[key];
      if (s?.status === 'warn') return `${s.label}: ${s.detail}`;
    }
    if (!isListening) return 'Mikrofon kapalı — "KONUŞUN" ile dinlemeyi başlatın';
    return null;
  })();

  /**
   * Bir aşama kutusunda gösterilecek KENDİ süresi + küçük ayrıntıları.
   *
   * Süreler `lastTurnLatency` alanlarından gelir; tur bazlı karşılığı olmayan
   * aşamalarda (AGENT, MIC) `—` gösterilir.
   */
  const stageCardInfo = useCallback(
    (key: StageKey): { value: string; sub: string[] } => {
      const l = lastLatency;
      const detail = stages[key]?.detail ?? '';
      if (!l) return { value: '—', sub: detail ? [detail] : [] };

      switch (key) {
        case 'vad':
          return {
            value: formatMs(l.vadMs),
            sub: [`sessizlik eşiği 600 ms`, ...(detail ? [detail] : [])],
          };
        case 'stt':
          return {
            value: formatMs(l.sttMs),
            sub: [
              l.sttModel ? l.sttModel.replace(/^whisper-/, 'whisper ') : '',
              l.sttPreprocessMs ? `ön işleme ${formatMs(l.sttPreprocessMs)}` : '',
              l.sttPostprocessMs ? `düzeltme ${formatMs(l.sttPostprocessMs)}` : '',
              l.sttFixes ? `${l.sttFixes} düzeltme` : '',
              l.sttChars > 0 ? `${l.sttChars} krkt` : 'transkript yok',
              ...(detail ? [detail] : []),
            ].filter(Boolean),
          };
        case 'llm':
          return {
            value: formatMs(l.llmMs),
            sub: [
              `ilk token ${formatMs(l.llmFirstTokenMs)}`,
              l.llmModel ? `model ${l.llmModel}` : '',
              l.replyChars > 0 ? `${l.replyChars} krkt` : '',
            ].filter(Boolean),
          };
        case 'mcp':
          return {
            value: l.mcpToolCount > 0 ? formatMs(l.mcpMs) : '—',
            sub:
              l.mcpToolCount > 0
                ? [`${l.mcpToolCount} araç`, l.mcpServers.join(', ')].filter(Boolean)
                : ['çağrı yok'],
          };
        case 'tts':
          return l.ttsEnabled
            ? {
                value: formatMs(l.ttsMs),
                sub: [`ilk parça ${formatMs(l.ttsFirstChunkMs)}`],
              }
            : { value: 'kapalı', sub: ['seslendirme kapalı'] };
        case 'playback':
          return l.ttsEnabled
            ? { value: formatMs(l.playbackMs), sub: ['hoparlör çalma'] }
            : { value: '—', sub: ['seslendirme kapalı'] };
        case 'agent':
          return { value: '—', sub: [`toplam ${formatMs(l.totalMs)}`, ...(detail ? [detail] : [])] };
        case 'mic':
        default:
          return { value: '—', sub: detail ? [detail] : [] };
      }
    },
    [lastLatency, stages]
  );

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'INPUT' ||
        target?.isContentEditable === true;

      // Yazarken kısayollar devre dışı: aksi halde boşluk tuşu mikrofonu kapatır.
      if (isTyping) return;

      // Escape to close/hide
      if (event.key === 'Escape') {
        window.diji?.hideWindow();
      }
      // Space to toggle mic
      if (event.code === 'Space' && !isMicMuted) {
        toggleMic();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isMicMuted, toggleMic]);

  return (
    <div className={`app-container ${panelOpen ? 'with-panel' : ''}`}>
      {/* Sol sütun: durum → reaktör → yetenek kartları → sohbet → giriş.
          Durum paneli akışın ilk öğesidir; reaktörü örtemez. */}
      <div className="main-stage" data-testid="main-stage">
        {/* Status Panel */}
        <div className="status-panel">
          <div className="status-label">DURUM / STATUS</div>
          <div
            className={`status-text ${
              isListening
                ? 'listening'
                : status === 'speaking'
                  ? 'speaking'
                  : status === 'processing'
                    ? 'processing'
                    : ''
            }`}
          >
            {statusMessage()}
          </div>
          {error && (
            <div className="mt-2 text-xs text-red-400 flex items-center gap-2">
              <XCircle className="w-4 h-4" /> {error}
            </div>
          )}
        </div>
        {/* Reactor Core */}
        <div className="reactor-wrap">
          <div className="reactor" data-testid="reactor">
            <div className={`reactor-ring ${activeNodes.size > 0 ? 'active' : ''}`} />
            <div
              className={`reactor-core ${activeNodes.size > 0 ? 'active' : ''}`}
              data-testid="reactor-core"
            >
              <Activity className="w-10 h-10 text-diji-text mx-auto opacity-80" />
            </div>
          </div>
        </div>

        {/* Yetenek kartları — büyük dairenin ALTINDA, sıralı ızgara.
            Mutlak konumlandırma yok: normal akışta `grid`. */}
        <div className="capability-grid" data-testid="capability-grid">
          {CAPABILITIES.map((node) => {
            const isActive = activeNodes.has(node.id);
            const Icon = node.icon;
            return (
              <button
                key={node.id}
                type="button"
                className={`capability-card ${isActive ? 'active' : 'inactive'}`}
                onClick={() => {
                  if (isActive) deactivateNode(node.id);
                  else activateNode(node.id);
                }}
                data-capability-card={node.id}
                data-testid={`node-${node.id}`}
                title={node.label}
              >
                <span className="capability-icon" style={{ color: isActive ? '#10b981' : node.color }}>
                  <Icon className="w-5 h-5" />
                </span>
                <span className="capability-body">
                  <span className="capability-name">{node.label}</span>
                  <span className="capability-state">{isActive ? 'AKTİF' : 'PASİF'}</span>
                </span>
                {isActive && (
                  <span
                    className="capability-dot"
                    data-testid={`node-${node.id}-active-indicator`}
                  />
                )}
              </button>
            );
          })}
        </div>

        {/* Sohbet paneli — yetenek kartlarının altında, metin girişinin üstünde */}
        <div className="chat-panel" data-testid="chat-panel">
          <div className="chat-head">
            <span className="chat-title">SOHBET</span>
            <span className="chat-count" data-testid="chat-count">
              {conversation.length} mesaj
            </span>
          </div>
          <div className="chat-list" ref={chatBoxRef} data-testid="chat-list">
            {visibleConversation.length === 0 && (
              <div className="chat-empty">henüz mesaj yok — yazın veya konuşun</div>
            )}
            {visibleConversation.map((msg) => {
              const isUser = msg.role === 'user';
              return (
                <div
                  key={msg.id}
                  className={`chat-bubble ${isUser ? 'user' : 'assistant'}`}
                  data-testid={`chat-bubble-${msg.role}`}
                >
                  <div className="chat-text">{msg.text}</div>
                  <div className="chat-meta">
                    <span className="chat-source" title={msg.source === 'voice' ? 'sesli' : 'metin'}>
                      {msg.source === 'voice' ? '🎤' : '⌨️'}
                    </span>
                    <span className="chat-clock">{formatClock(msg.at)}</span>
                    {!isUser && msg.latencyMs ? (
                      <span className="chat-latency" data-testid="chat-latency">
                        {formatLatency(msg.latencyMs)}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Metin giriş kutusu: Enter gönderir, Shift+Enter yeni satır. */}
          <div className="chat-composer">
            <textarea
              ref={composerRef}
              className="chat-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void sendMessage();
                }
              }}
              placeholder="Diji'ye yazın… (Enter gönderir, Shift+Enter yeni satır)"
              rows={2}
              data-testid="chat-input"
            />
            <button
              type="button"
              className={`chat-send ${sending ? 'busy' : ''}`}
              onClick={() => void sendMessage()}
              disabled={sending || draft.trim().length === 0}
              data-testid="chat-send"
              title="Gönder (Enter)"
            >
              {sending ? <span className="chat-send-label">gönderiliyor</span> : <Send size={15} />}
            </button>
            {/* Mikrofon aç/kapat — metin girişiyle aynı satırda */}
            <div
              className={`mic-indicator inline-mic ${isListening || isMicMuted ? 'active' : ''}`}
              onClick={toggleMic}
              data-testid="mic-indicator"
              title={isListening ? 'Dinlemeyi durdur' : 'Dinlemeyi başlat'}
            >
              <div
                className={`mic-dot ${isListening ? 'active' : ''}`}
                data-testid="mic-dot"
              />
              <div className="mic-label" data-testid="mic-label">
                {isListening ? 'DİNLEMEDE' : 'KONUŞUN'}
              </div>
              <Mic className={`w-4 h-4 ${isMicMuted ? 'text-gray-500' : 'text-diji-text'}`} />
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Controls */}
      <div className="absolute top-4 left-4 glass-panel px-4 py-2 rounded-full border border-white/10 flex items-center gap-3">
        <button
          onClick={() => window.diji?.hideWindow()}
          className="text-gray-400 hover:text-white transition-colors"
          title="Gizle / Hide"
        >
          <Power className="w-4 h-4" />
        </button>
        <button
          onClick={() => window.diji?.showWindow()}
          className="text-gray-400 hover:text-white transition-colors"
          title="Göster / Show"
        >
          <ArrowLeftRight className="w-4 h-4" />
        </button>
        <button
          onClick={() => setError(null)}
          className="text-gray-400 hover:text-white transition-colors"
          title="Hatası Kapat / Dismiss Error"
        >
          <XCircle className="w-4 h-4" />
        </button>
        <button
          onClick={() => {
            router.push('/settings');
          }}
          className="text-gray-400 hover:text-white transition-colors"
          title="Ayarlar / Settings"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>

      {/* Hotkey Hint */}
      <div
        className="absolute top-4 glass-panel px-3 py-1.5 rounded-lg text-[10px] text-gray-400"
        style={{ right: panelOpen ? 376 : 16 }}
      >
        ⌥Space: Pencereyi Aç/Kapat
      </div>

      {/* Teşhis paneli — pencerenin/ekranın sağ kenarı */}
      <aside className={`diag-panel ${panelOpen ? 'open' : 'closed'}`} data-testid="diag-panel">
        <div className="diag-head">
          <span
            className={`diag-link ${agentConnected ? 'on' : 'off'}`}
            data-testid="diag-link"
          />
          <span className="diag-title">HAT TELEMETRİSİ</span>
          <button
            className="diag-collapse"
            onClick={() => setPanelOpen((o) => !o)}
            title={panelOpen ? 'Paneli gizle' : 'Paneli göster'}
            data-testid="diag-toggle"
          >
            {panelOpen ? '−' : '≡'}
          </button>
        </div>

        {panelOpen && (
          <>
            <div
              className={`diag-bottleneck ${bottleneck ? 'alert' : 'ok'}`}
              data-testid="diag-bottleneck"
            >
              {bottleneck ?? 'Tüm aşamalar normal'}
            </div>

            {/* TOPLAM CEVAP SÜRESİ — panelin en üst satırı.
                Tur başlangıcı (kullanıcı konuşmayı bitirdi) → hoparlörden ilk
                ses çıktığı an. Değer `turn-latency` SSE olayı / `/state` alanı
                `lastTurnLatency` ile beslenir; tur yoksa `—`. */}
            <div
              className={`diag-total ${lastLatency ? 'has-value' : 'no-value'}`}
              data-testid="diag-total"
            >
              <div className="diag-total-line">
                <span className="diag-total-name">Toplam Cevap</span>
                <span className="diag-total-value">
                  {lastLatency ? formatMs(lastLatency.totalMs) : '—'}
                </span>
              </div>
              {lastLatency && (
                <div className="diag-total-breakdown" data-testid="diag-total-breakdown">
                  VAD {formatStageMs(lastLatency.vadMs)} · STT{' '}
                  {formatStageMs(lastLatency.sttMs)} · LLM {formatStageMs(lastLatency.llmMs)}
                  {lastLatency.mcpMs > 0 && <> · MCP {formatStageMs(lastLatency.mcpMs)}</>}
                  {' · '}TTS{' '}
                  {lastLatency.ttsEnabled ? formatStageMs(lastLatency.ttsMs) : 'kapalı'}
                </div>
              )}
            </div>

            {/* Aşama KUTULARI: her aşama kendi süresini ve ayrıntılarını
                kendi kutusunda gösterir. */}
            <div className="diag-stages" data-testid="diag-stages">
              {CARD_ORDER.map((key) => {
                const s = stages[key];
                const st: StageStatus = s?.status ?? 'idle';
                const info = stageCardInfo(key);
                // TTS kutusu: seslendirmeyi yeniden başlatmadan açıp kapatmaya
                // yarayan düğme. Durum ajanın `ttsEnabled` alanından gelir.
                const isTtsCard = key === 'tts';
                return (
                  <div
                    key={key}
                    className={`diag-card st-${st}`}
                    data-testid={`stage-${key}`}
                    data-stage-card={key}
                  >
                    <div className="diag-card-head">
                      <span className="diag-dot" />
                      <span className="diag-name">{s?.label ?? key.toUpperCase()}</span>
                      {isTtsCard ? (
                        <button
                          className={`diag-tts-toggle ${ttsEnabled ? 'on' : 'off'}`}
                          onClick={toggleTts}
                          disabled={ttsBusy || !agentConnected}
                          title={
                            ttsEnabled
                              ? 'Seslendirmeyi kapat (yeniden başlatma gerekmez)'
                              : 'Seslendirmeyi aç (yeniden başlatma gerekmez)'
                          }
                          data-testid="tts-toggle"
                        >
                          {ttsEnabled ? <Volume2 size={11} /> : <VolumeX size={11} />}
                        </button>
                      ) : null}
                      <span className="diag-badge">{STAGE_STATUS_TEXT[st]}</span>
                    </div>
                    <div className="diag-card-value" data-testid={`stage-${key}-value`}>
                      {info.value}
                    </div>
                    {info.sub.length > 0 && (
                      <div className="diag-card-sub">
                        {info.sub.map((line, i) => (
                          <span key={i}>{line}</span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="diag-loghead">
              OLAY AKIŞI
              <button
                className="diag-clear"
                onClick={() => setLogLines([])}
                title="Olay akışını temizle"
              >
                temizle
              </button>
            </div>
            <div className="diag-log" ref={logBoxRef} data-testid="diag-log">
              {logLines.length === 0 && <div className="diag-empty">henüz olay yok</div>}
              {logLines.map((line) => (
                <div key={line.id} className={`diag-logline lv-${line.level}`}>
                  <span className="diag-time">
                    {new Date(line.t).toLocaleTimeString('tr-TR', { hour12: false })}
                  </span>
                  <span className="diag-stage">{STAGE_SHORT[line.stage] ?? line.stage}</span>
                  <span className="diag-msg">{line.msg}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
