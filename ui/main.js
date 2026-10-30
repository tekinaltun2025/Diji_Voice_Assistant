"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWindow = createWindow;
exports.showWindow = showWindow;
exports.hideWindow = hideWindow;
exports.toggleWindow = toggleWindow;
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const url_1 = require("url");
const electron_store_1 = __importDefault(require("electron-store"));
const logger_1 = require("./logger");
const agent_bridge_1 = require("./agent-bridge");
const store = new electron_store_1.default();
let agentBridge = null;
// Next.js statik dışa aktarımı '/_next/...' gibi KÖK-göreli varlık yolları
// üretir. Sayfa file:// ile yüklenirse bu yollar dosya sisteminin köküne
// çözülür, hiçbir JS/CSS yüklenmez ve React hidrasyonu olmadığı için arayüz
// görünür ama TÜM düğmeler ölü kalır. Bu yüzden üretimde uygulama özel bir
// protokol (app://) üzerinden sunulur: kök-göreli yollar doğru çözülür.
const APP_SCHEME = 'app';
const APP_ORIGIN = `${APP_SCHEME}://diji`;
electron_1.protocol.registerSchemesAsPrivileged([
    {
        scheme: APP_SCHEME,
        privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
]);
const DEFAULT_SETTINGS = {
    autoStart: true,
    alwaysOnTop: true,
    showWindowOnCommand: true,
};
let mainWindow = null;
let isQuitting = false;
function getSettings() {
    const stored = store.get('settings');
    return stored ?? DEFAULT_SETTINGS;
}
function setSettings(settings) {
    const current = getSettings();
    store.set('settings', { ...current, ...settings });
}
function createWindow() {
    const { width, height } = electron_1.screen.getPrimaryDisplay().workAreaSize;
    const settings = getSettings();
    mainWindow = new electron_1.BrowserWindow({
        width: 1080,
        height: 560,
        x: Math.max(0, width - 1080 - 40),
        y: Math.max(0, Math.round((height - 560) / 2)),
        minWidth: 720,
        minHeight: 420,
        resizable: true,
        fullscreen: false,
        frame: false,
        transparent: true,
        alwaysOnTop: settings.alwaysOnTop,
        skipTaskbar: false,
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path_1.default.join(__dirname, 'preload.js'),
        },
        titleBarStyle: 'hidden',
    });
    if (process.env.NODE_ENV === 'development') {
        void mainWindow.loadURL('http://localhost:3000');
        mainWindow.webContents.openDevTools();
    }
    else {
        // Next.js statik export -> ui/out; app:// protokolü üzerinden sunulur ki
        // '/_next/...' varlık yolları doğru çözülsün (bkz. APP_SCHEME notu).
        void mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
    }
    mainWindow.on('blur', () => {
        if (mainWindow && !settings.autoStart) {
            mainWindow.hide();
        }
    });
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
    mainWindow.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault();
            mainWindow?.hide();
        }
    });
}
function showWindow() {
    if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
    }
    else {
        createWindow();
        // mainWindow is guaranteed after createWindow
        mainWindow.show();
        mainWindow.focus();
    }
}
function hideWindow() {
    if (mainWindow) {
        mainWindow.hide();
    }
}
function toggleWindow() {
    if (mainWindow && mainWindow.isVisible()) {
        hideWindow();
    }
    else {
        showWindow();
    }
}
function registerGlobalHotkey() {
    const hotkey = process.platform === 'darwin' ? 'Option+Space' : 'Alt+Space';
    const registered = electron_1.globalShortcut.register(hotkey, () => {
        toggleWindow();
    });
    if (!registered) {
        logger_1.logger.warn('Global hotkey registration failed', { hotkey });
    }
    else {
        logger_1.logger.info('Global hotkey registered', { hotkey });
    }
}
function unregisterGlobalHotkeys() {
    electron_1.globalShortcut.unregisterAll();
}
function setAutoStart(enabled) {
    electron_1.app.setLoginItemSettings({ openAtLogin: enabled });
    setSettings({ autoStart: enabled });
}
function setAlwaysOnTop(enabled) {
    if (mainWindow) {
        mainWindow.setAlwaysOnTop(enabled);
    }
    setSettings({ alwaysOnTop: enabled });
}
electron_1.app.whenReady().then(() => {
    // app:// protokolü: ui/out dizinini kök-göreli yollarla sunar.
    const outDir = path_1.default.join(__dirname, '..', '..', 'out');
    electron_1.protocol.handle(APP_SCHEME, (request) => {
        try {
            const url = new URL(request.url);
            let pathname = decodeURIComponent(url.pathname);
            if (pathname === '' || pathname === '/')
                pathname = '/index.html';
            if (pathname.endsWith('/'))
                pathname += 'index.html';
            const resolved = path_1.default.normalize(path_1.default.join(outDir, pathname));
            if (!resolved.startsWith(outDir)) {
                return new Response('forbidden', { status: 403 });
            }
            return electron_1.net.fetch((0, url_1.pathToFileURL)(resolved).toString());
        }
        catch (error) {
            logger_1.logger.error('app:// istegi basarisiz', { error: error.message });
            return new Response('not found', { status: 404 });
        }
    });
    createWindow();
    registerGlobalHotkey();
    // Ses ajanı köprüsü: ajanı ayakta tutar ve telemetriyi arayüze aktarır.
    agentBridge = new agent_bridge_1.AgentBridge(() => mainWindow);
    agentBridge.start();
    const settings = getSettings();
    if (settings.autoStart) {
        electron_1.app.setLoginItemSettings({ openAtLogin: true });
    }
    electron_1.app.on('activate', () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        electron_1.app.quit();
    }
});
electron_1.app.on('will-quit', () => {
    isQuitting = true;
    unregisterGlobalHotkeys();
    agentBridge?.stop();
    agentBridge = null;
});
// IPC Channels for UI↔Agent communication
electron_1.ipcMain.handle('diji:get-settings', () => {
    return getSettings();
});
electron_1.ipcMain.handle('diji:set-settings', (_event, settings) => {
    setSettings(settings);
    return getSettings();
});
electron_1.ipcMain.handle('diji:show-window', () => {
    showWindow();
    return { success: true };
});
electron_1.ipcMain.handle('diji:hide-window', () => {
    hideWindow();
    return { success: true };
});
electron_1.ipcMain.handle('diji:set-auto-start', (_event, enabled) => {
    setAutoStart(enabled);
    return { success: true };
});
electron_1.ipcMain.handle('diji:set-always-on-top', (_event, enabled) => {
    setAlwaysOnTop(enabled);
    return { success: true };
});
electron_1.ipcMain.on('voice-command', (event, command) => {
    logger_1.logger.info('Voice command received from UI', { command });
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
electron_1.ipcMain.handle('diji:agent-state', async () => {
    if (!agentBridge)
        return { ok: false, error: 'köprü hazır değil' };
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
electron_1.ipcMain.handle('diji:agent-listen', async (_event, enabled) => {
    if (!agentBridge)
        return { ok: false, error: 'köprü hazır değil' };
    const result = await agentBridge.listen(Boolean(enabled));
    return {
        ok: result.ok,
        connected: agentBridge.isConnected,
        error: result.ok ? null : result.error ?? 'dinleme isteği başarısız',
        data: result.data ?? null,
    };
});
electron_1.ipcMain.handle('diji:agent-ask', async (_event, text) => {
    if (!agentBridge)
        return { ok: false, error: 'köprü hazır değil' };
    const result = await agentBridge.ask(String(text ?? ''));
    return { ok: result.ok, error: result.ok ? null : result.error ?? 'istek reddedildi' };
});
electron_1.ipcMain.handle('diji:agent-confirm', async (_event, confirmed) => {
    if (!agentBridge)
        return { ok: false, error: 'köprü hazır değil' };
    const result = await agentBridge.confirm(Boolean(confirmed));
    return { ok: result.ok, error: result.ok ? null : result.error ?? 'onay iletilemedi' };
});
electron_1.ipcMain.on('agent:status-update', (_event, status) => {
    if (mainWindow) {
        mainWindow.webContents.send('diji:status-update', status);
    }
});
electron_1.ipcMain.on('agent:node-activate', (_event, nodeId) => {
    if (mainWindow) {
        mainWindow.webContents.send('diji:node-activate', nodeId);
    }
});
electron_1.ipcMain.on('agent:node-deactivate', (_event, nodeId) => {
    if (mainWindow) {
        mainWindow.webContents.send('diji:node-deactivate', nodeId);
    }
});
//# sourceMappingURL=main.js.map