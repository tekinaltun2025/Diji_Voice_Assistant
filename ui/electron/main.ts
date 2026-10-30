import {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  screen,
  protocol,
  net,
  Tray,
  Menu,
  nativeImage,
} from 'electron';
import path from 'path';
import fs from 'fs';
import { pathToFileURL } from 'url';
import Store from 'electron-store';
import { logger } from './logger';
import { AgentBridge } from './agent-bridge';

const store = new Store();

let agentBridge: AgentBridge | null = null;

// Next.js statik dışa aktarımı '/_next/...' gibi KÖK-göreli varlık yolları
// üretir. Sayfa file:// ile yüklenirse bu yollar dosya sisteminin köküne
// çözülür, hiçbir JS/CSS yüklenmez ve React hidrasyonu olmadığı için arayüz
// görünür ama TÜM düğmeler ölü kalır. Bu yüzden üretimde uygulama özel bir
// protokol (app://) üzerinden sunulur: kök-göreli yollar doğru çözülür.
const APP_SCHEME = 'app';
const APP_ORIGIN = `${APP_SCHEME}://diji`;

// ---- Sandbox politikası (Linux) ----
//
// AppImage içindeki `chrome-sandbox` SUID bitini taşıyamaz ve Ubuntu 24.04+
// `kernel.apparmor_restrict_unprivileged_userns=1` ile kullanıcı ad alanlarını
// kısıtlar. Bu iki durumda Chromium sandbox'ı başlatamayıp süreci öldürür.
//
// KRİTİK GÖZLEM (2026-10-27): `--no-sandbox` verildiğinde renderer alt süreci
// `platform_shared_memory_region_posix.cc` içinde
//   "Creating shared memory in /dev/shm/.org.chromium.Chromium.* failed"
//   "Unable to access(W_OK|X_OK) /dev/shm: No such process (3)"
// hatasını SANİYEDE on binlerce kez tekrarlıyor; 15 saniyede 169 MB–1,4 GB
// log üretiyor, pencere `IsUnMapped` kalıyor ve arayüz hiç çizilmiyordu.
// `--disable-dev-shm-usage` ve `--disable-gpu` sorunu ÇÖZMEDİ (ikincisi
// renderer'ı exitCode 133 ile çökertti).
// Sandbox AÇIK bırakıldığında (kullanıcı ad alanı sandbox'ı) renderer sağlıklı
// çalışıyor: log ~1 KB, sayfa çiziliyor, `document.querySelectorAll('button')`
// 7 düğme döndürüyor.
//
// Bu yüzden varsayılan davranış: sandbox AÇIK. Yalnızca kullanıcı ad alanı
// kısıtı varsa VE `chrome-sandbox` SUID değilse Chromium açılamaz; bu durumda
// `no-sandbox` zorunlu olarak devreye girer. `DIJI_ELECTRON_SANDBOX=1` ile
// sandbox her koşulda açık, `DIJI_ELECTRON_SANDBOX=0` ile kapalı tutulabilir.
{
  // Ölçüm: bu makinede `kernel.apparmor_restrict_unprivileged_userns=1`
  // olmasına VE `chrome-sandbox` SUID olmamasına rağmen sandbox'lı çalışma
  // sorunsuzdur (kullanıcı ad alanı sandbox'ı kullanılabilir). Bu yüzden
  // kısıt dosyasına bakıp otomatik `no-sandbox` AÇMAK yanlış bir varsayımdı.
  //
  // Varsayılan: sandbox AÇIK. Yalnızca `DIJI_ELECTRON_SANDBOX=0` ile kapatılır.
  const sandboxOverride = process.env.DIJI_ELECTRON_SANDBOX;
  if (sandboxOverride === '0') {
    app.commandLine.appendSwitch('no-sandbox');
    // Sandbox kapalıyken `/dev/shm` erişimi sorunlu olabilir; geçici
    // dosyalar `/tmp` altına taşınır.
    app.commandLine.appendSwitch('disable-dev-shm-usage');
  }
}

// NOT: `--disable-gpu` bu makinede renderer sürecini
// `render-process-gone {"reason":"crashed","exitCode":133}` ile öldürüyor
// (Wayland + Electron 28). Ekran kartı yolu çalışır durumda olduğu için
// switch EKLENMEZ.

// Renderer alt sürecinin shared-memory yeniden denemeleri saniyede yüz
// binlerce satır stderr üretiyordu (5 sn'de ~1,4 GB log). Bu, disk
// dolmasına yol açabileceği için Chromium gürültü seviyesi kısılır;
// uygulamanın kendi tanı logları (logger) etkilenmez.
app.commandLine.appendSwitch('log-level', '3');
app.commandLine.appendSwitch('disable-logging');

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

interface AppSettings {
  autoStart: boolean;
  alwaysOnTop: boolean;
  showWindowOnCommand: boolean;
}

const DEFAULT_SETTINGS: AppSettings = {
  autoStart: true,
  alwaysOnTop: true,
  showWindowOnCommand: true,
};

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
// Sistem tepsisi ikonu. `null` ise tray devre dışı (ikon bulunamadı vb.).
let tray: Tray | null = null;

// Tray'deki TTS onay kutusunun son bilinen durumu.
//
// Neden modül seviyesinde: `updateTrayMenu()` her çağrıldığında menü yeniden
// kurulur; onay kutusunun işaretini korumak için son değeri hatırlamak
// gerekir. Değer iki kaynaktan senkronlanır:
//   1) Ajanın SSE akışındaki `tts-toggle` olayı (anında — arayüzden veya
//      başka bir istemciden yapılan değişiklik),
//   2) `updateTrayMenu()` başındaki koşullu `/state` yoklaması (uygulama ilk
//      açıldığında ajan henüz hazır değilse gecikmeli düzeltme).
let ttsEnabledState = true;

function getSettings(): AppSettings {
  const stored = store.get('settings') as AppSettings | undefined;
  return stored ?? DEFAULT_SETTINGS;
}

function setSettings(settings: Partial<AppSettings>): void {
  const current = getSettings();
  store.set('settings', { ...current, ...settings });
}

function createWindow(): void {
  const wa = screen.getPrimaryDisplay().workArea;
  const settings = getSettings();

  // Pencereyi ekranın SAĞ kenarına yerleştir; küçük ekranlarda taşmasın.
  // `minWidth/minHeight` workArea'dan büyük olabilir (ör. küçük dizüstü
  // ekranı): bu durumda pencere ekran dışına taşar ve başlık çubuğu
  // erişilemez olur. Bu yüzden alt sınır da workArea ile sınırlanır.
  const minW = Math.min(720, Math.max(320, wa.width - 40));
  const minH = Math.min(420, Math.max(240, wa.height - 40));
  const winW = Math.min(1080, Math.max(minW, wa.width - 80));
  const winH = Math.min(560, Math.max(minH, wa.height - 80));
  const winX = Math.max(wa.x, wa.x + wa.width - winW - 24);
  const winY = Math.max(wa.y, wa.y + Math.round((wa.height - winH) / 2));

  mainWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x: winX,
    y: winY,
    minWidth: minW,
    minHeight: minH,
    resizable: true,
    movable: true,
    fullscreen: false,
    // Linux/GNOME Wayland: istemci tarafı süsleme (CSD) X11'deki gibi
    // çalışmaz. `frame: false` + `titleBarStyle: 'hidden'` kombinasyonu
    // penceresi başlık çubuğu, sürükleme tutamacı ve kapatma düğmesi
    // olmadan bırakıyordu; arayüzde `-webkit-app-region: drag` bölgesi de
    // tanımlı olmadığı için pencere hiç taşınamıyordu. Native çerçeve
    // açıldı: GNOME üst barı, Super+sürükle, Alt+F4 doğal çalışır.
    frame: true,
    // `transparent: true` Linux'ta yalnızca çerçevesiz pencerelerle
    // desteklenir; native çerçeveyle birlikte kullanılamaz.
    alwaysOnTop: settings.alwaysOnTop,
    skipTaskbar: false,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Varsayılan Electron menüsü (File/Edit/View…) GNOME üst barıyla
  // çakışmasın: menü çubuğu tamamen kapatılır.
  mainWindow.setMenuBarVisibility(false);

  if (process.env.NODE_ENV === 'development') {
    void mainWindow.loadURL('http://localhost:3000');
    mainWindow.webContents.openDevTools();
  } else {
    // Next.js statik export -> ui/out; app:// protokolü üzerinden sunulur ki
    // '/_next/...' varlık yolları doğru çözülsün (bkz. APP_SCHEME notu).
    void mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
  }

  // Eski davranış: pencere `blur` olduğunda `!autoStart` ise gizleniyordu.
  // Bu, native çerçeve sürüklemesini ve herhangi bir odak kaybını (alt
  // pencere, bildirim, workspace geçişi) pencerenin KAYBOLMASINA çeviriyordu.
  // Gizleme artık yalnızca kullanıcı eylemleriyle yapılır:
  //   - tepsi menüsü `Gizle` / sol tık,
  //   - `Alt+Space` global kısayolu,
  //   - arayüzdeki `diji:hide-window` IPC kanalı.
  // Yani otomatik blur-hide tamamen kaldırıldı.

  // Pencere ekran dışında/başlık çubuğu erişilemez bir konumda açılmasın:
  // önceki oturumdan kalan hayalet konumlara karşı görünür alanı doğrula.
  // Wayland'da konum X sunucusuna bırakılabilir; bu yalnızca güvenlik ağıdır.
  const ensureOnScreen = (): void => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    try {
      const bounds = win.getBounds();
      const area = screen.getDisplayMatching(bounds).workArea;
      const width = Math.min(bounds.width, area.width);
      const height = Math.min(bounds.height, area.height);
      const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width);
      const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height);
      if (
        x !== bounds.x ||
        y !== bounds.y ||
        width !== bounds.width ||
        height !== bounds.height
      ) {
        logger.warn('Pencere ekran disinda kaldi; gorunur alana tasindi', {
          once: bounds,
          sonra: { x, y, width, height },
        });
        win.setBounds({ x, y, width, height });
      }
    } catch (error) {
      logger.warn('Pencere konumu dogrulanamadi', { error: (error as Error).message });
    }
  };

  // `show: false` ile oluşturulup burada gösterilir: pencere beyaz/boş
  // kare olarak açılmaz ve (eski hatada olduğu gibi) hiç eşlenmemiş
  // kalmaz. `ready-to-show` tetiklenmezse yine de göster (güvenlik ağı).
  let shown = false;
  const revealWindow = (): void => {
    const win = mainWindow;
    if (shown || !win || win.isDestroyed()) return;
    shown = true;
    ensureOnScreen();
    win.show();
    win.focus();
    logger.info('Pencere gosterildi', { bounds: win.getBounds() });
  };
  mainWindow.once('ready-to-show', revealWindow);
  mainWindow.webContents.on('did-finish-load', revealWindow);
  // Yükleme 6 sn içinde bitmezse yine de göster (ağ/protokol takılması).
  const showFallback = setTimeout(revealWindow, 6000);

  // Renderer çökerse pencere boş kalır ve kimse nedenini görmez: nedeni
  // açıkça logla (ör. /dev/shm paylaşımlı bellek hatası).
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error('Renderer sureci sona erdi', {
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    logger.error('Preload yuklenemedi', { preloadPath, error: error.message });
  });

  mainWindow.on('closed', () => {
    clearTimeout(showFallback);
    mainWindow = null;
  });

  // Pencere görünürlüğü değiştikçe tepsi menüsü etiketi ("Göster"/"Gizle")
  // güncel kalsın. Tray yoksa updateTrayMenu sessizce döner.
  mainWindow.on('show', () => updateTrayMenu());
  mainWindow.on('hide', () => updateTrayMenu());

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}

function showWindow(): void {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
    // mainWindow is guaranteed after createWindow
    mainWindow!.show();
    mainWindow!.focus();
  }
}

function hideWindow(): void {
  if (mainWindow) {
    mainWindow.hide();
  }
}

function toggleWindow(): void {
  if (mainWindow && mainWindow.isVisible()) {
    hideWindow();
  } else {
    showWindow();
  }
}

/**
 * Tepsi ikonunun yolunu bulur.
 *
 * Geliştirme: <repo>/ui/assets/tray-icon.png
 * Paketlenmiş: process.resourcesPath veya asar içi electron/dist/../../assets
 * Hiçbiri bulunamazsa nativeImage boş döner — bu durumda tray oluşturulmaz
 * (uygulama sessizce çökmez, yalnızca ikon görünmez).
 */
function resolveTrayIcon(): Electron.NativeImage {
  const candidates = [
    path.join(__dirname, '..', '..', 'assets', 'tray-icon.png'), // dist/ -> ui/assets
    path.join(process.resourcesPath || '', 'assets', 'tray-icon.png'),
    path.join(process.cwd(), 'ui', 'assets', 'tray-icon.png'),
    path.join(process.cwd(), 'assets', 'tray-icon.png'),
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      const image = nativeImage.createFromPath(candidate);
      if (!image.isEmpty()) {
        logger.info('Tepsi ikonu yuklendi', { path: candidate, size: image.getSize() });
        return image.resize({ width: 22, height: 22 });
      }
    }
  }

  logger.warn('Tepsi ikonu bulunamadi', { denenen: candidates });
  return nativeImage.createEmpty();
}

/**
 * Tepsi bağlam menüsünü pencere görünürlüğüne ve TTS durumuna göre yeniler.
 * Tray yoksa sessizce döner (uygulama çökmez).
 */
function updateTrayMenu(): void {
  if (!tray) return;
  const visible = Boolean(mainWindow?.isVisible());

  // Durumu ajanın kendi görüşünden tazele (asenkron, bloklamadan).
  // Sonsuz döngü koruması: yalnızca DEĞER DEĞİŞTİĞİNDE menü yeniden kurulur;
  // değişmezse bu blok menüyü bir daha çizmez.
  void agentBridge?.state().then((result) => {
    const state = result?.data as { ttsEnabled?: boolean } | undefined;
    if (typeof state?.ttsEnabled === 'boolean' && state.ttsEnabled !== ttsEnabledState) {
      ttsEnabledState = state.ttsEnabled;
      logger.info('TTS durumu ajandan senkronlandi', { ttsEnabled: ttsEnabledState });
      updateTrayMenu();
    }
  });

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: visible ? 'Gizle' : 'Göster',
        click: () => toggleWindow(),
      },
      { type: 'separator' },
      {
        label: 'Sesli modu başlat',
        click: () => {
          showWindow();
          void agentBridge?.listen(true);
        },
      },
      {
        label: 'Sesli modu durdur',
        click: () => {
          void agentBridge?.listen(false);
        },
      },
      { type: 'separator' },
      {
        // TTS aç/kapat: ajan `ttsOverride` alanını değiştirir, süreç
        // yeniden başlatılmaz — sonraki turdan itibaren geçerlidir.
        label: 'TTS (seslendirme)',
        type: 'checkbox',
        checked: ttsEnabledState,
        click: (item) => {
          ttsEnabledState = item.checked;
          logger.info('TTS tepsi anahtari degisti', { enabled: item.checked });
          void agentBridge?.tts(item.checked);
          updateTrayMenu();
        },
      },
      { type: 'separator' },
      {
        label: 'Çıkış',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
}

/** Sistem tepsisi ikonu — göster / gizle / kapat menüsü. */
function createTray(): void {
  if (tray) return;

  const icon = resolveTrayIcon();
  if (icon.isEmpty()) {
    logger.warn('Tepsi ikonu olusturulamadi; tray devre disi');
    return;
  }

  try {
    tray = new Tray(icon);
    tray.setToolTip('Diji — Türkçe Sesli Asistan');

    updateTrayMenu();
    // Sol tık: pencereyi göster/gizle. Menü etiketi pencere olaylarından
    // (show/hide) zaten yenilenir; tıklama sonrası da tazelenir.
    tray.on('click', () => {
      toggleWindow();
      updateTrayMenu();
    });

    logger.info('Tepsi ikonu hazir');
  } catch (error) {
    // Tepsi desteklenmeyen masaüstü ortamlarında (ör. Wayland/başsız X)
    // uygulama çökmemeli; tray sessizce devre dışı kalır.
    logger.warn('Tepsi olusturulamadi; tray devre disi', {
      error: (error as Error).message,
    });
    tray = null;
  }
}

function registerGlobalHotkey(): void {
  const hotkey = process.platform === 'darwin' ? 'Option+Space' : 'Alt+Space';
  const registered = globalShortcut.register(hotkey, () => {
    toggleWindow();
  });

  if (!registered) {
    logger.warn('Global hotkey registration failed', { hotkey });
  } else {
    logger.info('Global hotkey registered', { hotkey });
  }
}

function unregisterGlobalHotkeys(): void {
  globalShortcut.unregisterAll();
}

function setAutoStart(enabled: boolean): void {
  app.setLoginItemSettings({ openAtLogin: enabled });
  setSettings({ autoStart: enabled });
}

function setAlwaysOnTop(enabled: boolean): void {
  if (mainWindow) {
    mainWindow.setAlwaysOnTop(enabled);
  }
  setSettings({ alwaysOnTop: enabled });
}

app.whenReady().then(() => {
  // app:// protokolü: ui/out dizinini kök-göreli yollarla sunar.
  const outDir = path.join(__dirname, '..', '..', 'out');
  protocol.handle(APP_SCHEME, (request) => {
    try {
      const url = new URL(request.url);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === '' || pathname === '/') pathname = '/index.html';
      if (pathname.endsWith('/')) pathname += 'index.html';
      const resolved = path.normalize(path.join(outDir, pathname));
      if (!resolved.startsWith(outDir)) {
        return new Response('forbidden', { status: 403 });
      }
      return net.fetch(pathToFileURL(resolved).toString());
    } catch (error) {
      logger.error('app:// istegi basarisiz', { error: (error as Error).message });
      return new Response('not found', { status: 404 });
    }
  });

  createWindow();
  registerGlobalHotkey();
  // Tepsi ikonu pencereden SONRA oluşturulur; menü etiketi pencere
  // görünürlüğüne göre hazırlanabilsin.
  createTray();

  // Ses ajanı köprüsü: ajanı ayakta tutar ve telemetriyi arayüze aktarır.
  agentBridge = new AgentBridge(() => mainWindow);
  // Ajan TTS anahtarını (tray/arayüz) SSE üzerinden anında yansıt: menüyü
  // yalnızca değer değiştiğinde yeniden kur (döngü koruması).
  agentBridge.setTtsChangeListener((enabled) => {
    if (enabled === ttsEnabledState) return;
    ttsEnabledState = enabled;
    updateTrayMenu();
  });
  agentBridge.start();

  const settings = getSettings();
  if (settings.autoStart) {
    app.setLoginItemSettings({ openAtLogin: true });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  // app.quit() herhangi bir yerden çağrılabilir (OS oturum kapanışı, tray
  // menüsü, sinyal). Bu bayrak olmadan `close` olayı preventDefault eder ve
  // çıkış iptal olur; kullanıcı uygulamayı kapatamaz.
  isQuitting = true;
  // Ajan alt süreci yetim kalmasın: SIGTERM gönderilir, ajan kendi
  // `shutdown()` yolundan geçer (kontrol sunucusu kapanır, pipeline dispose
  // edilir). `will-quit` içinde tekrar çağrılması zararsızdır (idempotent).
  agentBridge?.stop();
});

app.on('window-all-closed', () => {
  // Tepside kalmaya devam et; gerçek çıkış yalnızca tray menüsünden.
  // Tray oluşturulamadıysa eski davranış korunur (uygulama kapanır).
  if (tray) {
    logger.info('Tum pencereler kapandi; tepside kaliniyor');
    return;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  isQuitting = true;
  unregisterGlobalHotkeys();
  // Tepsi ikonunu serbest bırak; aksi halde bazı masaüstlerinde
  // hayalet ikon kalır.
  if (tray) {
    try {
      tray.destroy();
    } catch (error) {
      logger.warn('Tepsi ikonu kaldirilamadi', { error: (error as Error).message });
    }
    tray = null;
  }
  agentBridge?.stop();
  agentBridge = null;
});

// IPC Channels for UI↔Agent communication
ipcMain.handle('diji:get-settings', () => {
  return getSettings();
});

ipcMain.handle('diji:set-settings', (_event, settings: Partial<AppSettings>) => {
  setSettings(settings);
  return getSettings();
});

ipcMain.handle('diji:show-window', () => {
  showWindow();
  return { success: true };
});

ipcMain.handle('diji:hide-window', () => {
  hideWindow();
  return { success: true };
});

ipcMain.handle('diji:set-auto-start', (_event, enabled: boolean) => {
  setAutoStart(enabled);
  return { success: true };
});

ipcMain.handle('diji:set-always-on-top', (_event, enabled: boolean) => {
  setAlwaysOnTop(enabled);
  return { success: true };
});

ipcMain.on('voice-command', (event, command: string) => {
  logger.info('Voice command received from UI', { command });
  // Arayüzdeki mikrofon düğmesi buradan gerçek ajana bağlanır: köprü yoksa
  // (ajan açılamadıysa) arayüz "ajan bağlı değil" durumunu görür.
  const lower = String(command).toLowerCase();
  const wantsStop = lower.includes('durdur') || lower.includes('kapat') || lower.includes('stop');
  void agentBridge?.listen(!wantsStop).then((result) => {
    event.reply('voice-response', {
      status: result?.ok ? 'applied' : 'failed',
      command,
      detail: result?.error ?? null,
    });
  });
});

// ---- Ses ajanı köprüsü (teşhis paneli + mikrofon kontrolü) ----
ipcMain.handle('diji:agent-state', async () => {
  if (!agentBridge) return { ok: false, error: 'köprü hazır değil' };
  const result = await agentBridge.state();
  if (!result.ok) {
    return {
      ok: false,
      connected: agentBridge.isConnected,
      error: result.error ?? 'ajan yanıt vermedi',
    };
  }
  return { ok: true, connected: true, data: result.data };
});

ipcMain.handle('diji:agent-listen', async (_event, enabled: boolean) => {
  if (!agentBridge) return { ok: false, error: 'köprü hazır değil' };
  const result = await agentBridge.listen(Boolean(enabled));
  return {
    ok: result.ok,
    connected: agentBridge.isConnected,
    error: result.ok ? null : result.error ?? 'dinleme isteği başarısız',
    data: result.data ?? null,
  };
});

ipcMain.handle('diji:agent-tts', async (_event, enabled: boolean | null) => {
  if (!agentBridge) return { ok: false, error: 'köprü hazır değil' };
  const result = await agentBridge.tts(typeof enabled === 'boolean' ? enabled : null);
  // Tray onay kutusunu arayüzden yapılan değişiklikle eşitle.
  const data = result.data as { enabled?: boolean } | undefined;
  if (result.ok && typeof data?.enabled === 'boolean' && data.enabled !== ttsEnabledState) {
    ttsEnabledState = data.enabled;
    updateTrayMenu();
  }
  return {
    ok: result.ok,
    enabled: data?.enabled ?? ttsEnabledState,
    error: result.ok ? null : result.error ?? 'TTS isteği başarısız',
  };
});

ipcMain.handle('diji:agent-ask', async (_event, text: string) => {
  if (!agentBridge) return { ok: false, error: 'köprü hazır değil' };
  const result = await agentBridge.ask(String(text ?? ''));
  return { ok: result.ok, error: result.ok ? null : result.error ?? 'istek reddedildi' };
});

ipcMain.handle('diji:agent-confirm', async (_event, confirmed: boolean) => {
  if (!agentBridge) return { ok: false, error: 'köprü hazır değil' };
  const result = await agentBridge.confirm(Boolean(confirmed));
  return { ok: result.ok, error: result.ok ? null : result.error ?? 'onay iletilemedi' };
});

ipcMain.on('agent:status-update', (_event, status: string) => {
  if (mainWindow) {
    mainWindow.webContents.send('diji:status-update', status);
  }
});

ipcMain.on('agent:node-activate', (_event, nodeId: string) => {
  if (mainWindow) {
    mainWindow.webContents.send('diji:node-activate', nodeId);
  }
});

ipcMain.on('agent:node-deactivate', (_event, nodeId: string) => {
  if (mainWindow) {
    mainWindow.webContents.send('diji:node-deactivate', nodeId);
  }
});

export { createWindow, showWindow, hideWindow, toggleWindow, createTray, updateTrayMenu };