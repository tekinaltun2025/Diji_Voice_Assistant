// Jarvis — Electron ana süreci.
// dist/client altındaki SPA derlemesini app:// özel protokolüyle yükler:
// - Yönlendirici kök yolu ("/") gördüğü için "/" rotası eşleşir.
// - Sabit bir kaynak (origin) olduğundan sohbet geçmişi (localStorage) kalıcıdır.
// - Mikrofon izni yerel olarak onaylanır; hiçbir ağ kaydı yapılmaz.
const { app, BrowserWindow, session, protocol, net, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
// Ajan köprüsü: SSE + REST istemcisi (Electron'dan bağımsız, test edilebilir).
const { createAgentBridge } = require("./agent-bridge.cjs");

const CLIENT_ROOT = path.join(__dirname, "..", "dist", "client");
const e2e = process.env.JARVIS_E2E === "1";

// Tek pencere ve tek köprü örneği (IPC kanalları bir kez kaydedilsin diye modül düzeyinde).
let win = null;
/** @type {ReturnType<typeof createAgentBridge> | null} */
let bridge = null;

// app:// kök yol çözümlemesi yapabilen standart bir şema olmalı (app.ready'den ÖNCE).
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

// TanStack Start SPA derlemesi kabuk dosyasını sürüme göre "index.html" veya
// "_shell.html" olarak yazar; hangisi varsa onu kök belge kabul et.
function resolveRootDocument() {
  for (const candidate of ["/index.html", "/_shell.html"]) {
    const full = path.join(CLIENT_ROOT, candidate);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return candidate;
  }
  return "/index.html";
}

function serveClient(url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/" || rel === "") rel = resolveRootDocument();
  const file = path.join(CLIENT_ROOT, rel);
  if (!file.startsWith(CLIENT_ROOT)) return new Response("forbidden", { status: 403 });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) rel = resolveRootDocument();
  return net.fetch(pathToFileURL(path.join(CLIENT_ROOT, rel)).toString());
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 460,
    minHeight: 620,
    title: "Jarvis — Türkçe Sesli Asistan",
    backgroundColor: "#eef1f6",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Renderer'a yalnızca window.diji yüzeyini açan izole köprü betiği.
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  // Mikrofon (ses görselleştirme) izni: kullanıcı medya izni verdiğinde onayla.
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media");
  });
  ses.setPermissionCheckHandler((_wc, permission) => permission === "media");

  win.loadURL("app://jarvis/");

  if (e2e) {
    const out = process.env.JARVIS_E2E_OUT || "/tmp/jarvis-electron/shot.png";
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        const image = await win.webContents.capturePage();
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, image.toPNG());
        console.log("E2E_SHOT", out);
        app.quit();
      }, 3500);
    });
  }

  // Pencere kapanırken referansı bırak (köprü "pencere yok" durumunu doğru görsün).
  win.on("closed", () => {
    win = null;
  });
}

app.whenReady().then(() => {
  protocol.handle("app", (request) => serveClient(new URL(request.url)));
  createWindow();

  // Ajanı Electron İÇİNDEN başlatmıyoruz: ajan süreci başlatıcı betiğin işi.
  // Böylece iki ajan süreci mikrofon için yarışmaz; burada sadece bağlanıyoruz.
  bridge = createAgentBridge({
    port: Number(process.env.DIJI_CONTROL_PORT || 8899),
    getWindow: () => win,
    log: (...args) => console.log("[bridge]", ...args),
  });
  // SSE telemetri akışını ve yeniden bağlanma döngüsünü başlat.
  bridge.start();

  // IPC kanalları YALNIZCA BİR KEZ kaydedilir (ipcMain.handle tekrar kayıtta hata verir).
  ipcMain.handle("diji:state", () => bridge.getState());
  ipcMain.handle("diji:listen", (_event, enabled) => bridge.listen(Boolean(enabled)));
  ipcMain.handle("diji:ask", (_event, text) => bridge.ask(String(text ?? "")));
  ipcMain.handle("diji:set-tts", (_event, enabled) => bridge.setTts(Boolean(enabled)));
  ipcMain.handle("diji:confirm", (_event, confirmed) => bridge.confirm(Boolean(confirmed)));
  ipcMain.handle("diji:barge-in", () => bridge.bargeIn());
  // Ayarlar ekranı: model listesi + seçim (çalışma zamanı motor değişimi).
  ipcMain.handle("diji:models", () => bridge.getModels());
  ipcMain.handle("diji:select-model", (_event, kind, id) => bridge.selectModel(kind, id));
});

// Uygulama kapanırken SSE bağlantısını ve yeniden bağlanma zamanlayıcısını temizle.
app.on("before-quit", () => {
  bridge?.stop();
  bridge = null;
});

app.on("window-all-closed", () => {
  bridge?.stop();
  app.quit();
});
