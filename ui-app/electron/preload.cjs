// Diji köprü katmanı — renderer (izole dünya) ile ana süreç arasındaki tek kapı.
// CommonJS: paket "type":"module" olduğu için .cjs uzantısı zorunlu.
// contextIsolation açık olduğundan Node API'leri SADECE burada görünür; renderer'a
// yalnızca aşağıdaki dar yüzey (window.diji) aktarılır.
const { contextBridge, ipcRenderer } = require("electron");

/**
 * Abonelik sızıntısını önleyen ortak dinleyici kurucusu.
 * Geriye kaldırma (unsubscribe) fonksiyonu döner; React useEffect temizliğinde
 * doğrudan çağrılabilir.
 * @param {string} channel IPC kanal adı
 * @param {(payload: unknown) => void} cb renderer geri çağrısı
 * @returns {() => void}
 */
function subscribe(channel, cb) {
  const handler = (_event, payload) => {
    // Renderer tarafındaki hata ana süreci çökertmesin.
    try {
      cb(payload);
    } catch (error) {
      console.error(`[diji] ${channel} dinleyicisi hata verdi:`, error);
    }
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  // ------------------------------------------------------------------ sorgular
  /** Ajanın tam durum görüntüsü (/state). Hata durumunda { ok:false, error }. */
  getState: () => ipcRenderer.invoke("diji:state"),
  /** Köprünün bu pencerede bulunduğunu doğrulayan sabit bayrak. */
  isAvailable: () => true,

  // ------------------------------------------------------------------- eylemler
  /** Mikrofon/ajan dinlemesini aç/kapat. */
  listen: (enabled) => ipcRenderer.invoke("diji:listen", Boolean(enabled)),
  /** Metin sorusu gönderir; yanıt 202 + accepted döner, metin SSE'den gelir. */
  ask: (text) => ipcRenderer.invoke("diji:ask", String(text ?? "")),
  /** TTS motorunu aç/kapat. */
  setTts: (enabled) => ipcRenderer.invoke("diji:set-tts", Boolean(enabled)),
  /** Onay bekleyen işlemi yanıtla (alan adı ajan tarafında `confirmed`). */
  confirm: (confirmed) => ipcRenderer.invoke("diji:confirm", Boolean(confirmed)),
  /** Devam eden konuşmayı/oynatmayı kes (barge-in). */
  bargeIn: () => ipcRenderer.invoke("diji:barge-in"),
  /** Ayarlar ekranının model listeleri (`GET /models`). */
  getModels: () => ipcRenderer.invoke("diji:models"),
  /** Model değiştir (`POST /models/select`). */
  selectModel: (kind, id) =>
    ipcRenderer.invoke("diji:select-model", String(kind ?? ""), String(id ?? "")),

  // -------------------------------------------------------------------- olaylar
  /** SSE telemetri akışı: stage/log/turn-latency/conversation-update/snapshot. */
  onTelemetry: (cb) => subscribe("diji:telemetry", cb),
  /** Ajan bağlantı durumu: { connected, error? }. */
  onConnection: (cb) => subscribe("diji:connection", cb),

  // ------------------------------------------------------------------ kimlik
  isElectron: true,
  version: "1.0.0",
};

contextBridge.exposeInMainWorld("diji", api);
