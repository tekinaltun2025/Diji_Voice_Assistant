import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ArrowDownLeft, ArrowUp, AudioLines, CircuitBoard, Cpu, History, MemoryStick, Mic, MicOff, PanelLeftClose, Plus, Trash2, Wifi, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { QuantumWave } from "@/components/quantum-wave";
import { useAgent } from "@/hooks/use-agent";
import type { ConversationItem, ModelKind, Stage, StageStatus } from "@/types/diji";
import { Power, Settings2, Mail, CalendarDays, CloudSun, Globe, HardDrive, StickyNote, Hash, Brain, Activity, FileText, Box, Network, Volume2, Play, Send, MessageSquare, Minus, Maximize2, Minimize2, X } from "lucide-react";

type Message = { id: string; role: "user" | "assistant"; text: string; time: number };
type Conversation = { id: string; title: string; updatedAt: number; messages: Message[] };

const STORAGE_KEY = "aura-widget-conversations-v1";
const starter: Conversation = {
  id: "welcome", title: "İlk konuşma", updatedAt: 0,
  messages: [
    { id: "hello", role: "assistant", text: "Merhaba, ben Jarvis. Aklından geçenleri yazabilir veya mikrofonu açıp konuşabilirsin.", time: 0 },
  ],
};

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Jarvis — Kuantum Cam Sesli Asistan" },
      { name: "description", content: "Kuantum Cam Jarvis: mikrofon sesine tepki veren akışkan dalga ve yerel sohbet arayüzü." },
      { property: "og:title", content: "Jarvis — Kuantum Cam Sesli Asistan" },
      { property: "og:description", content: "Beyaz cam Jarvis arayüzü ve gerçek zamanlı, yerel mikrofon ses görselleştirmesi." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function formatTime(value: number) {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
}

/** Ajan `status` → kartta görünen Türkçe etiket (tasarımın mevcut sözlüğü). */
const STATUS_LABEL: Record<StageStatus, string> = {
  active: "AKTİF",
  ready: "HAZIR",
  idle: "BEKLİYOR",
  error: "HATA",
};

/** Kart etiketi → ajan aşama anahtarı (`agent/mic/vad/stt/llm/mcp/tts/playback`). */
function stageKeyFor(label: string) {
  return label.toLowerCase();
}

/** Aşamanın sağ değeri: önce ölçülen süre, sonra kısa ayrıntı, yoksa "—". */
function stageReadout(stage: Stage | undefined) {
  if (!stage) return "—";
  const metrics = stage.metrics ?? {};
  const duration = metrics["sure"] ?? metrics["toplam"] ?? metrics["ilk token"];
  if (duration !== undefined && duration !== null && duration !== "") return String(duration);
  const detail = (stage.detail ?? "").trim();
  if (!detail) return "—";
  // Kart 94 px yüksekliğinde ve `b` tek satır: ayrıntı kırpılır, uydurulmaz.
  return detail.length > 14 ? `${detail.slice(0, 13)}…` : detail;
}

/**
 * Ajan sohbet akışını yerel listeye katar.
 * Ajan hem kullanıcı hem asistan mesajını yayınlar; lokal iyimser balonla
 * aynı turu iki kez göstermemek için `id` ve `rol|metin` imzasıyla tekilleştirilir.
 */
function mergeAgentMessages(current: Message[], incoming: ConversationItem[]): Message[] {
  if (!incoming.length) return current;
  const seenIds = new Set(current.map((message) => message.id));
  const seenSignatures = new Set(current.map((message) => `${message.role}|${message.text.trim()}`));
  const extra: Message[] = [];
  for (const item of incoming) {
    if (!item || typeof item.text !== "string") continue;
    const text = item.text.trim();
    if (!text) continue;
    const id = item.id || `agent-${item.at}-${text.length}`;
    const signature = `${item.role}|${text}`;
    if (seenIds.has(id) || seenSignatures.has(signature)) continue;
    seenIds.add(id);
    seenSignatures.add(signature);
    extra.push({ id, role: item.role === "user" ? "user" : "assistant", text, time: item.at || Date.now() });
  }
  return extra.length ? [...current, ...extra] : current;
}

/**
 * Servis kartları — `key` ajanın MCP sunucu adıdır; durum
 * `/state.mcpServers` verisinden okunur (sabit "PASİF" etiketi yoktur).
 *
 * `HAVA` (hava durumu) ayrı bir MCP sunucusu DEĞİLDİR: ajanın araç
 * listesinde hava durumu sunucusu yok. Bu yüzden kart gizlenmez, ancak
 * durumu "SUNUCU YOK" olarak dürüstçe gösterilir.
 */
const services: Array<{ label: string; key: string | null; icon: LucideIcon }> = [
  { label: "GMAIL", key: "gmail", icon: Mail },
  { label: "TAKVİM", key: "calendar", icon: CalendarDays },
  { label: "SLACK", key: "slack", icon: Hash },
  { label: "HAVA", key: null, icon: CloudSun },
  { label: "NOTION", key: "notion", icon: StickyNote },
  { label: "DRIVE", key: "drive", icon: HardDrive },
  { label: "CHROME", key: "chrome", icon: Globe },
];
const modules = [
  { label: "AGENT", icon: Brain }, { label: "MIC", icon: Mic },
  { label: "VAD", icon: Activity }, { label: "STT", icon: FileText },
  { label: "LLM", icon: Box }, { label: "MCP", icon: Network },
  { label: "TTS", icon: Volume2 }, { label: "PLAYBACK", icon: Play },
];

/**
 * Ayarlar panelindeki model bölümleri.
 *
 * Sıra sabittir ve `ModelKind` anahtarlarıyla ajan `/models` yanıtına eşlenir.
 * Seçenekler BURADA tanımlanmaz: liste tamamen ajanın diskten/sunucudan
 * okuduğu katalogdan gelir (yalnızca makinede gerçekten olan modeller).
 */
const MODEL_SECTIONS: Array<{ kind: ModelKind; title: string; hint: string; icon: LucideIcon }> = [
  { kind: "stt", title: "SES TANIMA (STT)", hint: "Whisper modelleri. Seçim motoru yeniden başlatır.", icon: FileText },
  { kind: "llm", title: "DİL MODELİ (LLM)", hint: "Yerel sunucudaki modeller. Seçim anında geçerli olur.", icon: Box },
  { kind: "tts", title: "SESLENDİRME (TTS)", hint: "VITS modelleri. Seçim motoru yeniden başlatır.", icon: Volume2 },
];

function Index() {
  const {
    connected, available, state, stages, logs, conversation, lastTurnLatency,
    micLevel, isListening, isSpeaking, toggleListen, ask, confirm, bargeIn,
    pendingConfirmation, mcpServers,
    modelCatalog, modelsLoading, modelSwitching, loadModels, selectModel,
  } = useAgent();

  const [conversations, setConversations] = useState<Conversation[]>([starter]);
  const [activeId, setActiveId] = useState(starter.id);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState(false);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [micPending, setMicPending] = useState(false);
  /** Pencerenin büyütülmüş olup olmadığı — başlık çubuğundaki ikonu sürer. */
  const [maximized, setMaximized] = useState(false);
  const [eventsCleared, setEventsCleared] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Ayarlar panelindeki model değişimi geri bildirimi (durum metni). */
  const [modelNotice, setModelNotice] = useState("");
  const active = conversations.find((item) => item.id === activeId) ?? conversations[0];
  // Ajan mikrofonu sahiplenir: yerel getUserMedia yerine bu bayrak kullanılır.
  const micOn = isListening;

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as { conversations?: Conversation[]; activeId?: string };
        if (Array.isArray(parsed.conversations) && parsed.conversations.length > 0) {
          setConversations(parsed.conversations.map((conversation) => ({
            ...conversation,
            messages: conversation.messages.map((message) => message.id === "hello" && message.role === "assistant" && message.text === "Merhaba, ben Aura. Aklından geçenleri yazabilir veya mikrofonu açıp konuşabilirsin."
              ? { ...message, text: "Merhaba, ben Jarvis. Aklından geçenleri yazabilir veya mikrofonu açıp konuşabilirsin." }
              : message),
          })));
          if (parsed.activeId && parsed.conversations.some((item) => item.id === parsed.activeId)) setActiveId(parsed.activeId);
        }
      }
    } catch { /* A damaged local history should not prevent the widget opening. */ }
    setReady(true);
  }, []);

  useEffect(() => {
    if (ready) localStorage.setItem(STORAGE_KEY, JSON.stringify({ conversations, activeId }));
  }, [conversations, activeId, ready]);

  // Ajanın sohbet akışı (SSE `conversation-update`) aktif konuşmaya eklenir.
  useEffect(() => {
    if (!conversation.length) return;
    setConversations((items) => items.map((item) => {
      if (item.id !== activeId) return item;
      const merged = mergeAgentMessages(item.messages, conversation);
      if (merged === item.messages) return item;
      const last = merged[merged.length - 1];
      return { ...item, messages: merged, updatedAt: Math.max(item.updatedAt, last?.time ?? item.updatedAt) };
    }));
  }, [conversation, activeId]);

  useEffect(() => { messagesEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [activeId, active?.messages.length]);

  // Başlık çubuğundaki büyütme ikonu Electron'un gerçek durumunu yansıtsın:
  // açılışta bir kez sorulur, sonra `maximize`/`unmaximize` olayları dinlenir
  // (F11, masaüstü ortamının kendi kısayolları da kapsanır).
  useEffect(() => {
    const controls = window.diji?.windowControls;
    if (!controls) return;
    let active = true;
    void controls.isMaximized().then((value) => {
      if (active) setMaximized(Boolean(value));
    }).catch(() => { /* durum okunamazsa varsayılan (false) korunur */ });
    const off = controls.onMaximizedChange((value) => setMaximized(Boolean(value)));
    return () => { active = false; off(); };
  }, []);

  // Model listeleri tembeldir: LLM bölümü yerel sunucuya istek atar (~2,5 sn).
  // Bu yüzden yalnızca panel açıldığında tazelenir, açılışı yavaşlatmaz.
  useEffect(() => {
    if (!settingsOpen) return;
    void loadModels();
  }, [settingsOpen, loadModels]);

  function addMessage(text: string) {
    const clean = text.trim();
    if (!clean) return;
    const now = Date.now();
    setConversations((items) => items.map((item) => item.id === activeId ? {
      ...item,
      title: item.messages.some((message) => message.role === "user") ? item.title : clean.slice(0, 34),
      updatedAt: now,
      messages: [...item.messages, { id: crypto.randomUUID(), role: "user" as const, text: clean, time: now }],
    } : item));
    setDraft("");
    setNotice(available ? "" : "Ajan köprüsü yok — mesaj yalnızca bu cihazda kaydedildi.");
    // Yanıt metni dönmez: asistan balonu SSE `conversation-update` ile gelir.
    void ask(clean);
    inputRef.current?.focus();
  }

  function newConversation() {
    const id = crypto.randomUUID();
    setConversations((items) => [{ id, title: "Yeni konuşma", updatedAt: Date.now(), messages: [] }, ...items]);
    setActiveId(id);
    setHistoryOpen(false);
    setDraft("");
    setNotice("");
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function deleteConversation(id: string) {
    const remaining = conversations.filter((item) => item.id !== id);
    if (!remaining.length) {
      const fresh = { id: crypto.randomUUID(), title: "Yeni konuşma", updatedAt: Date.now(), messages: [] };
      setConversations([fresh]);
      setActiveId(fresh.id);
    } else {
      setConversations(remaining);
      if (activeId === id && remaining[0]) setActiveId(remaining[0].id);
    }
  }

  // Mikrofonu ajan sahiplenir; yerel MediaStream/AudioContext tamamen kaldırıldı.
  /**
   * Başlık çubuğundaki pencere düğmeleri (`küçült` / `büyüt` / `kapat`).
   * Tarayıcıda (`window.diji === undefined`) sessizce hiçbir şey yapmaz, böylece
   * `vite dev` önizlemesi bozulmaz. Hata renderer'ı çökertmesin diye yakalanır.
   */
  async function windowAction(action: "minimize" | "maximize" | "close"): Promise<void> {
    const controls = window.diji?.windowControls;
    if (!controls) return;
    try {
      if (action === "minimize") {
        await controls.minimize();
        return;
      }
      if (action === "close") {
        await controls.close();
        return;
      }
      const result = await controls.toggleMaximize();
      if (result.ok && typeof result.maximized === "boolean") setMaximized(result.maximized);
    } catch (error) {
      setNotice(`Pencere işlemi başarısız: ${(error as Error).message}`);
    }
  }

  async function toggleMic() {
    if (micPending) return;
    setMicPending(true);
    setNotice("");
    try {
      if (micOn) {
        await toggleListen();
      } else {
        await toggleListen();
        if (!available) setNotice("Ajan köprüsü bulunamadı — mikrofon yalnızca masaüstü uygulamasında açılır.");
      }
    } finally { setMicPending(false); }
  }

  /**
   * Onay bekleyen MCP işlemini yanıtlar.
   *
   * Diyalog iyimser kapatılmaz: gerçek kapanış ajanın `confirmation` olayıyla
   * gelir. `applied:false` (zaman aşımı) durumunda kullanıcıya bildirilir.
   */
  async function resolveConfirmation(approved: boolean) {
    const ok = await confirm(approved);
    if (!approved) {
      setNotice("İşlem reddedildi.");
      return;
    }
    setNotice(ok ? "İşlem onaylandı." : "Onay iletilemedi — işlem zaman aşımına uğramış olabilir.");
  }

  /**
   * Ayarlar panelinden model değiştirir.
   *
   * Liste kontrollüdür: seçili değer her zaman katalogdaki `current` alanıdır
   * (ajan bunu ÇALIŞAN motordan okur). Değişim başarısız olursa ajan eski
   * modeliyle devam eder, katalog tazelenince kontrol eski değere döner —
   * arayüz başarısız bir seçimi "seçili" göstermez.
   *
   * Seçim ajan tarafından `~/.config/diji/env` dosyasına YAZILIR, yani
   * uygulama yeniden başlatıldığında da geçerli olur. Yazma başarısız
   * olursa (`persisted:false`) kullanıcı açıkça uyarılır: model şu an
   * değişti ama yeniden başlatınca eskiye döner.
   */
  async function changeModel(kind: ModelKind, id: string) {
    if (!id) return;
    setModelNotice("");
    const result = await selectModel(kind, id);
    if (!result.ok) {
      setModelNotice(result.reason ? `Değiştirilemedi: ${result.reason}` : "Model değiştirilemedi.");
      return;
    }

    const name = result.current ?? id;
    const parts = [`Değişti: ${name}`];
    if (result.slow) parts.push("(yavaş geçiş tamamlandı)");
    parts.push(result.persisted ? "· kalıcı kaydedildi" : "· yalnızca bu oturum");
    if (result.persistError) parts.push(`— ${result.persistError}`);
    setModelNotice(parts.join(" "));
  }

  /** Onay sayacı: `expiresAt` doluysa kalan saniye, değilse 0. */
  const confirmationSecondsLeft = (() => {
    const expiresAt = pendingConfirmation?.expiresAt;
    if (!expiresAt) return null;
    return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  })();

  /**
   * Servis kartının durumu — GERÇEK MCP bağlantısından türetilir.
   * Sunucu listesi boşsa ajan MCP'yi başlatamamıştır ("BAĞLI DEĞİL").
   */
  function serviceStatusFor(key: string | null): string {
    if (!key) return "SUNUCU YOK";
    if (!mcpServers.length) return "BAĞLI DEĞİL";
    const server = mcpServers.find((item) => item.name === key);
    if (!server) return "TANIMSIZ";
    if (!server.connected) return "PASİF";
    return server.toolCount > 0 ? `${server.toolCount} ARAÇ` : "HAZIR";
  }

  /** MCP aşaması sistem genelinde etkin mi (sidebar alt satırı için). */
  const mcpStageActive = stages["mcp"]?.status === "active";
  const totalResponseText = typeof lastTurnLatency?.totalMs === "number"
    ? `${(lastTurnLatency.totalMs / 1000).toFixed(1)} sn`
    : "—";
  const ttsBytes = state?.turnMetrics?.ttsBytes;
  const ttsText = typeof ttsBytes === "number" && ttsBytes > 0 ? `${Math.round(ttsBytes / 1024)} KB` : "09";
  const lastLog = logs.length ? logs[logs.length - 1] : undefined;
  const eventLabel = micOn ? "ŞİMDİ · MIC" : "AJAN";
  const eventText = lastLog?.msg
    ? (lastLog.msg.length > 48 ? `${lastLog.msg.slice(0, 47)}…` : lastLog.msg)
    : (connected ? "Ajan bağlı — olay bekleniyor." : "Bağlantı kurulmadı.");

  return (
    <main className="quantum-desktop">
      <div className="quantum-caption"><span>02 / KUANTUM CAM</span><span>JARVIS · YEREL SES ARAYÜZÜ</span></div>
      <section className="quantum-console" aria-label="Jarvis sesli asistan">
        <header className="quantum-header">
          <div className="quantum-brand"><AudioLines size={25} /><h1>JARVIS</h1><span>Türkçe Sesli Asistan</span></div>
          <div className="window-controls">
            <button type="button" className="window-button" title="Küçült" aria-label="Pencereyi küçült" onClick={() => void windowAction("minimize")}><Minus size={15} /></button>
            <button type="button" className="window-button" title={maximized ? "Eski boyuta döndür" : "Büyüt"} aria-label={maximized ? "Pencereyi eski boyuta döndür" : "Pencereyi büyüt"} aria-pressed={maximized} onClick={() => void windowAction("maximize")}>{maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button>
            <button type="button" className="window-button window-button-close" title="Kapat" aria-label="Pencereyi kapat" onClick={() => void windowAction("close")}><X size={16} /></button>
          </div>
        </header>
        <div className="quantum-layout">
          <aside className="quantum-sidebar">
            <nav className="system-controls" aria-label="Jarvis kontrolleri">
              <Button variant="ghost" onClick={toggleMic} disabled={micPending}><Power size={18} /><span>Güç</span><i className={micOn ? "status-dot on" : "status-dot"} /></Button>
              <Button variant="ghost" onClick={() => { setHistoryOpen(true); setSettingsOpen(false); }}><History size={18} /><span>Geçmiş</span></Button>
              <Button variant="ghost" onClick={newConversation}><Plus size={18} /><span>Yeni sohbet</span></Button>
              <Button variant="ghost" onClick={() => { setSettingsOpen(!settingsOpen); setHistoryOpen(false); }} aria-expanded={settingsOpen}><Settings2 size={18} /><span>Ayarlar</span></Button>
            </nav>
            <div className="service-list">{services.map(({ label, key, icon: Icon }) => <div className="service-item" key={label}><Icon size={23} /><div><strong>{label}</strong><span>{serviceStatusFor(key)}</span></div></div>)}</div>
            <div className="sidebar-bottom"><span className="status-dot" /> YEREL OTURUM</div>
          </aside>
          <div className="quantum-center">
            <section className="quantum-stage" aria-label="Ses görselleştirmesi">
              <div className="stage-status">
                <span>DURUM / STATUS</span>
                <h2>{micPending ? "AÇILIYOR" : isSpeaking ? "KONUŞUYOR" : micOn ? "DİNLİYOR" : "HAZIR"}</h2>
                <p>Alt+Space: Geçmişi Aç/Kapat</p>
                {isSpeaking && (
                  <Button variant="outline" size="sm" className="barge-in-button" onClick={() => void bargeIn()}>
                    Sesi kes
                  </Button>
                )}
              </div>
              <QuantumWave level={micLevel} listening={micOn} />
              <div className="stage-bottom"><span><i className={micOn ? "status-dot on" : "status-dot"} />{micOn ? "MİKROFON AKTİF" : "SES GİRİŞİ KAPALI"}</span><span>{micOn ? `${Math.round(micLevel * 100)}%` : "—"} / GİRİŞ SEVİYESİ</span></div>
            </section>
            <section className="quantum-chat" aria-label="Sohbet">
              <div className="section-heading"><h2>SOHBET</h2><span>{active?.messages.length ?? 0} mesaj</span></div>
              <div className="chat-messages scroll-thin" aria-label="Mesajlar" aria-live="polite">
                {!active?.messages.length && <div className="empty-chat"><MessageSquare size={30} /><p>henüz mesaj yok — yazın veya konuşun</p></div>}
                {active?.messages.map(message => <div className={`quantum-message ${message.role === "user" ? "user-message" : ""}`} key={message.id}><span>{message.role === "user" ? "SEN" : "JARVIS"} · {formatTime(message.time)}</span><p>{message.text}</p></div>)}
                <div ref={messagesEnd} />
              </div>
              {notice && <p className="quantum-notice" role="status">{notice}</p>}
              <div className="quantum-composer"><div className="composer-input"><textarea ref={inputRef} rows={1} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); addMessage(draft); } }} aria-label="Mesaj yaz" placeholder="Jarvis'e yazın…" /><Button variant="ghost" size="icon" aria-label="Mesajı gönder" title="Gönder" disabled={!draft.trim()} onClick={() => addMessage(draft)}><Send size={19} /></Button></div><Button className={`quantum-mic ${micOn ? "listening" : ""}`} variant="outline" size="icon" onClick={toggleMic} disabled={micPending} aria-label={micOn ? "Mikrofonu kapat" : "Mikrofonu aç"} aria-pressed={micOn} title={micOn ? "Mikrofonu kapat" : "Mikrofonu aç"}>{micOn ? <MicOff size={24} /> : <Mic size={24} />}</Button></div>
              <div className="composer-caption"><span>Enter gönderir · Shift+Enter yeni satır</span><span>{micOn ? "DURDUR" : "KONUŞUN"}</span></div>
            </section>
          </div>
          <aside className="quantum-telemetry">
            <h2>HAT TELEMETRİSİ</h2>
            <div className="connection-alert" style={{ display: connected ? "none" : "flex" }}><span>!</span>Ajan bağlı değil — bağlantı kurulmadı</div>
            {pendingConfirmation && (
              <div className="confirmation-alert" role="alertdialog" aria-live="assertive" aria-label="İşlem onayı">
                <div className="confirmation-head">
                  <span>ONAY GEREKLİ</span>
                  {confirmationSecondsLeft !== null && <b>{confirmationSecondsLeft} sn</b>}
                </div>
                <p className="confirmation-question">{pendingConfirmation.question}</p>
                <dl className="confirmation-meta">
                  <dt>Sunucu</dt><dd>{pendingConfirmation.server}</dd>
                  <dt>Araç</dt><dd>{pendingConfirmation.tool}</dd>
                  <dt>İzin</dt><dd>{pendingConfirmation.permission}</dd>
                  <dt>Neden</dt><dd>{pendingConfirmation.reason}</dd>
                </dl>
                <div className="confirmation-actions">
                  <Button variant="outline" onClick={() => void resolveConfirmation(false)}>Reddet</Button>
                  <Button onClick={() => void resolveConfirmation(true)}>Onayla</Button>
                </div>
              </div>
            )}
            <div className="total-response"><span>TOPLAM CEVAP</span><strong>{totalResponseText}</strong></div>
            <div className="module-grid">{modules.map(({ label, icon: Icon }) => {
              const stage = stages[stageKeyFor(label)];
              const isMic = label === "MIC";
              const statusLabel = stage ? STATUS_LABEL[stage.status] : "BEKLİYOR";
              const readout = isMic ? (micOn ? `${Math.round(micLevel * 100)}%` : "—") : stageReadout(stage);
              return <div className={`module-cell ${label === "MIC" && micOn ? "module-active" : ""}`} key={label}><div><Icon size={19} /><strong>{label}</strong></div><span>{statusLabel}</span><b>{readout}</b></div>;
            })}</div>
            <div className="event-heading"><h3>OLAY AKIŞI</h3><Button variant="ghost" onClick={() => setEventsCleared(true)}>temizle</Button></div>
            <div className="event-stream">{!eventsCleared && <><span>{eventLabel}</span><p>{eventText}</p></>}</div>
            <div className="telemetry-footer"><span>TTS <b>{ttsText}</b></span><span>{connected ? "YEREL / BAĞLI" : "YEREL / BAĞLANTI YOK"}</span><span>{mcpStageActive ? "MCP AKTİF" : "MCP BOŞTA"}</span></div>
          </aside>
        </div>
        {settingsOpen && (
          <div className="quantum-settings" role="dialog" aria-label="Ayarlar">
            <div className="section-heading"><h2>AYARLAR</h2><Button variant="ghost" size="icon" aria-label="Ayarları kapat" onClick={() => setSettingsOpen(false)}><X size={18} /></Button></div>
            <p>Ses yalnızca bu cihazda analiz edilir; kayıt alınmaz veya sunucuya gönderilmez.</p>
            <p>{connected ? "Yapay zekâ ve servis bağlantıları etkin." : "Yapay zekâ ve servis bağlantıları etkin değil."}</p>
            <div className="settings-models">
              <div className="settings-models-head"><h3>MODELLER</h3><Button variant="ghost" onClick={() => void loadModels()} disabled={modelsLoading}>yenile</Button></div>
              <p className="settings-note">Seçim kalıcı kaydedilir (~/.config/diji/env); uygulama yeniden başlasa da geçerli olur.</p>
              {modelsLoading && !modelCatalog && <p className="settings-note">Modeller taranıyor…</p>}
              {!modelsLoading && !modelCatalog && <p className="settings-note">Model listesi alınamadı — ajan bağlı mı?</p>}
              {modelCatalog && MODEL_SECTIONS.map(({ kind, title, hint, icon: Icon }) => {
                const section = modelCatalog[kind];
                const options = section?.options ?? [];
                const current = section?.current ?? "";
                const selected = options.find((option) => option.id === current);
                return (
                  <div className="settings-model" key={kind}>
                    <div className="settings-model-title"><Icon size={15} /><span>{title}</span>{modelSwitching === kind && <b>{kind === "tts" ? "yükleniyor… (60 sn'ye kadar)" : "değişiyor…"}</b>}</div>
                    <select
                      className="settings-select"
                      aria-label={title}
                      value={selected ? current : ""}
                      disabled={modelSwitching !== null || options.length === 0}
                      onChange={(event) => void changeModel(kind, event.target.value)}
                    >
                      {!selected && <option value="">{current || "— seçim yok —"}</option>}
                      {options.map((option) => (
                        <option key={option.id} value={option.id} disabled={!option.available}>
                          {option.available ? option.label : `${option.label} (kullanılamıyor)`}
                        </option>
                      ))}
                    </select>
                    <span className="settings-model-detail">{selected?.detail ?? hint}</span>
                  </div>
                );
              })}
              {modelCatalog?.modelsDir && <p className="settings-note">Klasör: {modelCatalog.modelsDir}</p>}
              {modelNotice && <p className="settings-note" role="status">{modelNotice}</p>}
            </div>
          </div>
        )}
        {historyOpen && <aside className="quantum-history" aria-label="Sohbet geçmişi"><div className="section-heading"><h2>GEÇMİŞ</h2><Button variant="ghost" size="icon" aria-label="Geçmişi kapat" onClick={() => setHistoryOpen(false)}><X size={18} /></Button></div>{conversations.map(item => <div className="history-row" key={item.id}><Button variant="ghost" onClick={() => { setActiveId(item.id); setHistoryOpen(false); }}>{item.title}</Button><Button variant="ghost" size="icon" title="Konuşmayı sil" aria-label={`${item.title} konuşmasını sil`} onClick={() => deleteConversation(item.id)}><Trash2 size={15} /></Button></div>)}<Button variant="outline" onClick={newConversation}><Plus size={16} />Yeni konuşma</Button></aside>}
      </section>
      <footer className="quantum-page-footer"><span>KUANTUM CAM / 02</span><span>SES İŞLEME: BU CİHAZDA</span></footer>
    </main>
  );
}
