// Diji ajan köprüsü — SAF Node.js (Electron bağımlılığı yok, birim testi yapılabilir).
// Görev: 127.0.0.1:8899 üzerindeki ajanla SSE + REST konuşmak, sonucu renderer'a aktarmak.
// Kural: hiçbir metot throw ETMEZ; her hata { ok:false, error } olarak döner.
const http = require("node:http");

/** GET istekleri için zaman aşımı (ms). */
const TIMEOUT_GET = 4000;
/** Kısa POST istekleri için zaman aşımı (ms). */
const TIMEOUT_POST = 8000;
/** `ask` 202 ile hemen döner; LLM'in uzun sürmesi ihtimaline karşı geniş bırakıldı (ms). */
const TIMEOUT_ASK = 60000;

// Model listesi: ajan LLM bölümü için yerel sunucuya ayrıca istek atar
// (~2,5 sn sunucu aşımı). Kısa aşım çalışan kurulumda boş liste gösterirdi.
const TIMEOUT_MODELS = 20000;

// Model değişimi: STT yeniden yükleme ~1-4 sn; drifting-tts geçişi Python
// köprüsünü yeniden kurduğu için ~60-70 sn sürebilir.
const TIMEOUT_MODEL_SELECT = 120000;
/** İlk yeniden bağlanma gecikmesi (ms). */
const RECONNECT_BASE = 1500;
/** Yeniden bağlanma gecikmesi üst sınırı (ms). */
const RECONNECT_MAX = 15000;

/**
 * Ajan köprüsünü oluşturur.
 * @param {object} options
 * @param {number} [options.port=8899] ajan kontrol sunucusu portu
 * @param {() => any} [options.getWindow] Electron BrowserWindow döndüren işlev
 * @param {(...args: any[]) => void} [options.log] günlükleyici
 */
function createAgentBridge({ port = 8899, getWindow, log } = {}) {
  const logger = typeof log === "function" ? log : () => {};

  /** Aktif SSE isteği. */
  let sseRequest = null;
  /** Yeniden bağlanma zamanlayıcısı. */
  let reconnectTimer = null;
  /** `stop()` çağrıldı mı? */
  let stopped = false;
  /** Son bilinen bağlantı durumu (aynı değeri tekrar göndermemek için). */
  let connected = false;
  /** Üstel geri çekilme için güncel gecikme (ms). */
  let backoff = RECONNECT_BASE;

  /**
   * Renderer'a olay gönderir. Pencere yoksa veya yıkıldıysa sessizce geçer.
   * @param {string} channel IPC kanalı
   * @param {unknown} payload gövde
   */
  function send(channel, payload) {
    try {
      const win = typeof getWindow === "function" ? getWindow() : null;
      if (!win) return;
      const wc = win.webContents;
      if (!wc) return;
      if (typeof wc.isDestroyed === "function" && wc.isDestroyed()) return;
      wc.send(channel, payload);
    } catch (error) {
      // Renderer hazır değilken oluşan hatalar akışı bozmasın.
      logger("renderer gonderilemedi:", error && error.message ? error.message : error);
    }
  }

  /**
   * Bağlantı durumunu renderer'a bildirir (değişmediyse yayın yapmaz).
   * @param {boolean} value yeni durum
   * @param {string} [error] hata açıklaması
   */
  function setConnected(value, error) {
    if (connected === value) return;
    connected = value;
    const payload = { connected: value };
    if (error) payload.error = String(error);
    logger(value ? "ajana baglandi" : "ajan baglantisi koptu", error || "");
    send("diji:connection", payload);
  }

  /**
   * HTTP isteği yürütür; asla throw etmez.
   * @param {string} method HTTP metodu
   * @param {string} pathname istek yolu
   * @param {object|null} body JSON gövde (null → gövde yok)
   * @param {number} timeoutMs zaman aşımı
   * @returns {Promise<any>} ayrıştırılmış JSON veya { ok:false, error }
   */
  function request(method, pathname, body, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      /** Tek seferlik çözümleme (çift resolve'u engeller). */
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      let payload = null;
      const headers = { Accept: "application/json" };
      if (body !== null && body !== undefined) {
        try {
          payload = Buffer.from(JSON.stringify(body), "utf8");
        } catch (error) {
          done({ ok: false, error: `govde serilestirilemedi: ${error && error.message ? error.message : error}` });
          return;
        }
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = String(payload.length);
      }

      let req;
      try {
        req = http.request(
          { host: "127.0.0.1", port, path: pathname, method, headers, timeout: timeoutMs },
          (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
              const text = Buffer.concat(chunks).toString("utf8");
              let parsed = null;
              if (text) {
                try {
                  parsed = JSON.parse(text);
                } catch {
                  // Gövde JSON değilse ham metni hata olarak döndür.
                  done({ ok: false, error: `gecersiz JSON (HTTP ${res.statusCode}): ${text.slice(0, 200)}` });
                  return;
                }
              }
              if (res.statusCode && res.statusCode >= 400) {
                /*
                 * GOVDE KORUNUR.
                 *
                 * Ajan, "gecis yapmadi" durumlarini 400/409 ile ve ANLAMLI bir
                 * govdeyle bildirir. Ornegin `/llm/provider` anahtar yoksa
                 *   { ok:false, current:"local", apiKeyRequired:true, reason:"…" }
                 * doner. Bu alanlar atilirsa arayuz "anahtar gerekli" sinyalini
                 * goremez ve parola alanini ACAMAZ — canli dogrulamada tam
                 * olarak bu yasandi.
                 *
                 * Bu yuzden once govde yayilir, sonra koprunun kendi alanlari
                 * yazilir (status her zaman gercek HTTP kodu kalir).
                 */
                done({
                  ...(parsed && typeof parsed === "object" ? parsed : {}),
                  ok: false,
                  status: res.statusCode,
                  error:
                    (parsed && (parsed.error || parsed.detail || parsed.message || parsed.reason)) ||
                    `HTTP ${res.statusCode}`,
                });
                return;
              }
              done(parsed === null ? { ok: true, status: res.statusCode } : parsed);
            });
            res.on("error", (error) => {
              done({ ok: false, error: `yanit okunamadi: ${error && error.message ? error.message : error}` });
            });
          }
        );
      } catch (error) {
        done({ ok: false, error: `istek olusturulamadi: ${error && error.message ? error.message : error}` });
        return;
      }

      // Zaman aşımı: soketi kapat ve anlamlı hata döndür.
      req.on("timeout", () => {
        req.destroy(new Error("timeout"));
        done({ ok: false, error: `zaman asimi (${timeoutMs}ms): ${method} ${pathname}` });
      });
      req.on("error", (error) => {
        done({ ok: false, error: error && error.message ? error.message : String(error) });
      });

      if (payload) req.write(payload);
      req.end();
    });
  }

  /**
   * SSE akışına bağlanır. Olay tipi HTTP başlığında DEĞİL, `data` gövdesindeki
   * `type` alanında gelir; bu yüzden `event:` satırı saklanır ama kullanılmaz.
   */
  function connectStream() {
    if (stopped) return;

    let req;
    try {
      req = http.get(
        {
          host: "127.0.0.1",
          port,
          path: "/events",
          headers: { Accept: "text/event-stream", "Cache-Control": "no-cache" },
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            setConnected(false, `HTTP ${res.statusCode}`);
            scheduleReconnect();
            return;
          }

          // Bağlantı kuruldu: geri çekilmeyi sıfırla.
          backoff = RECONNECT_BASE;
          setConnected(true);

          let buffer = "";
          res.setEncoding("utf8");

          res.on("data", (chunk) => {
            buffer += chunk;

            // SSE çerçeveleri boş satırla ayrılır.
            let index = buffer.indexOf("\n\n");
            while (index >= 0) {
              const block = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              index = buffer.indexOf("\n\n");

              // Çok satırlı `data:` alanlarını birleştir.
              const dataLines = [];
              for (const rawLine of block.split("\n")) {
                const line = rawLine.replace(/\r$/, "");
                if (line.startsWith("data:")) {
                  dataLines.push(line.slice(5).trimStart());
                }
                // `event:` ve `retry:` satırları bilinçli olarak yok sayılır.
              }
              if (dataLines.length === 0) continue;

              const text = dataLines.join("\n");
              let parsed;
              try {
                parsed = JSON.parse(text);
              } catch {
                // Bozuk çerçeve akışı bozmasın.
                continue;
              }
              // snapshot dahil tüm olaylar olduğu gibi renderer'a gider.
              send("diji:telemetry", parsed);
            }
          });

          res.on("end", () => {
            setConnected(false, "akis kapandi");
            scheduleReconnect();
          });
          res.on("error", (error) => {
            setConnected(false, error && error.message ? error.message : "akis hatasi");
            scheduleReconnect();
          });
        }
      );
    } catch (error) {
      setConnected(false, error && error.message ? error.message : "baglanti hatasi");
      scheduleReconnect();
      return;
    }

    sseRequest = req;
    req.on("error", (error) => {
      setConnected(false, error && error.message ? error.message : "baglanti hatasi");
      scheduleReconnect();
    });
  }

  /** Üstel geri çekilmeyle (1.5s → 3s → 6s → … max 15s) yeniden bağlanmayı planlar. */
  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, RECONNECT_MAX);
    logger(`yeniden baglanma planlandi: ${delay}ms`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectStream();
    }, delay);
    // Süreç kapanışını bu zamanlayıcı bloklamasın.
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  return {
    /** SSE akışını başlatır (tek seferlik; tekrar çağrı bağlantıyı çoğaltmaz). */
    start() {
      if (sseRequest || reconnectTimer) return;
      stopped = false;
      backoff = RECONNECT_BASE;
      connectStream();
    },

    /** Akışı kapatır, zamanlayıcıyı temizler ve yeniden bağlanmayı durdurur. */
    stop() {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (sseRequest) {
        const req = sseRequest;
        sseRequest = null;
        try {
          req.destroy();
        } catch {
          /* zaten kapalı */
        }
      }
      if (connected) {
        connected = false;
        send("diji:connection", { connected: false, error: "koprü durduruldu" });
      }
    },

    /** Tam durum görüntüsü. */
    getState() {
      return request("GET", "/state", null, TIMEOUT_GET);
    },

    /** Dinlemeyi aç/kapat. */
    listen(enabled) {
      return request("POST", "/listen", { enabled: Boolean(enabled) }, TIMEOUT_POST);
    },

    /** Metin sorusu; 202 + accepted döner, yanıt metni SSE'den gelir. */
    ask(text) {
      return request("POST", "/ask", { text: String(text ?? "") }, TIMEOUT_ASK);
    },

    /** TTS aç/kapat. */
    setTts(enabled) {
      return request("POST", "/tts", { enabled: Boolean(enabled) }, TIMEOUT_POST);
    },

    /** Onay bekleyen işlemi yanıtla — alan adı KESİNLİKLE `confirmed`. */
    confirm(confirmed) {
      return request("POST", "/confirm", { confirmed: Boolean(confirmed) }, TIMEOUT_POST);
    },

    /** Devam eden oynatmayı/konuşmayı kes. */
    bargeIn() {
      return request("POST", "/bargein", {}, TIMEOUT_POST);
    },

    /**
     * Ayarlar ekranının model listeleri.
     *
     * Zaman aşımı uzun: LLM bölümü için ajan yerel model sunucusuna ayrıca
     * istek atar (LLM_SLOW = 2,5 sn sunucu aşımı + yedek satır). Kısa bir
     * aşım, çalışan bir kurulumda boş liste gösterirdi.
     */
    getModels() {
      return request("GET", "/models", null, TIMEOUT_MODELS);
    },

    /**
     * Model değiştir. `kind`: `stt` | `tts` | `llm`.
     *
     * Uzun aşım: STT yeniden yükleme (~1-4 sn), drifting-tts geçişi Python
     * köprüsünü yeniden kurar (~60-70 sn). Kısa aşım kullanıcıya "başarısız"
     * dedirtirdi; ajan geçişi tamamlamış olsa bile.
     */
    selectModel(kind, id) {
      return request(
        "POST",
        "/models/select",
        { kind: String(kind ?? ""), id: String(id ?? "") },
        TIMEOUT_MODEL_SELECT
      );
    },

    /**
     * LLM sağlayıcısını değiştir (yerel ↔ DeepSeek).
     *
     * `apiKey` istekte yalnızca bir kez taşınır; ajan onu 0600 izinli
     * `~/.config/diji/secrets/<provider>.key` dosyasına yazar ve yanıtta
     * ASLA geri döndürmez. Uzak sağlayıcı için anahtar yoksa yanıt
     * `{ ok:false, apiKeyRequired:true }` olur.
     *
     * Uzun aşım: geçiş öncesi `/v1/models` doğrulaması ve sağlık kontrolü
     * yapılır (ağ turu). Yeni sağlayıcıya ulaşılamazsa geçiş geri alınır.
     */
    selectLlmProvider(provider, apiKey) {
      const body = { provider: String(provider ?? "") };
      if (typeof apiKey === "string" && apiKey.trim()) body.apiKey = apiKey.trim();
      return request("POST", "/llm/provider", body, TIMEOUT_MODEL_SELECT);
    },

    /** SSE bağlantısı şu an açık mı? */
    isConnected() {
      return connected;
    },
  };
}

module.exports = { createAgentBridge };
