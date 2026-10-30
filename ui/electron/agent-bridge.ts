/**
 * Ajan köprüsü — Electron ana süreci ile ses ajanı arasındaki tek hat.
 *
 * Ajan kendi kontrol sunucusunu (varsayılan 127.0.0.1:8899) açar. Bu köprü:
 *   1) Ajan ayakta değilse arka planda başlatır (node agent/dist/index.js),
 *   2) /events SSE akışına abone olup telemetriyi arayüze aktarır,
 *   3) arayüzün "dinlemeyi başlat/durdur" ve "metin gönder" isteklerini iletir.
 *
 * Arayüz mikrofonu doğrudan açmaz: sesin tek sahibi ajandır.
 */
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { BrowserWindow } from 'electron';
import { logger } from './logger';

export interface ControlResult {
  ok: boolean;
  status?: number;
  data?: unknown;
  error?: string;
}

type WindowGetter = () => BrowserWindow | null;

export class AgentBridge {
  private readonly port: number;
  private readonly getWindow: WindowGetter;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private sseRequest: http.ClientRequest | null = null;
  private agentProc: ChildProcess | null = null;
  private spawning = false;
  private connected = false;
  private stopped = true;
  /**
   * TTS anahtarı değiştiğinde çağrılır (ajan `tts-toggle` olayı).
   *
   * Neden köprüde: Electron ana süreci tray menüsünü ajanın GERÇEK durumuna
   * göre günceller. Arayüzden yapılan bir değişiklik de aynı olayı ürettiği
   * için tray işaretli kalır — ayrıca `/state` yoklamasına gerek kalmaz.
   */
  private ttsChangeListener: ((enabled: boolean) => void) | null = null;

  constructor(getWindow: WindowGetter, port = Number(process.env.DIJI_CONTROL_PORT || 8899)) {
    this.getWindow = getWindow;
    this.port = port;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** TTS anahtarı değişim dinleyicisini kaydeder (tray senkronizasyonu). */
  setTtsChangeListener(listener: (enabled: boolean) => void): void {
    this.ttsChangeListener = listener;
  }

  /** Köprüyü başlatır: ajanı ayakta tutar ve olay akışına bağlanır. */
  start(): void {
    this.stopped = false;
    void this.ensureAgent().then((ok) => {
      if (!ok) {
        logger.warn('Ajan baslatilamadi; yeniden denenecek', { port: this.port });
      }
      this.connectStream();
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sseRequest) {
      try {
        this.sseRequest.destroy();
      } catch {
        /* yoksay */
      }
      this.sseRequest = null;
    }
    if (this.agentProc && !this.agentProc.killed) {
      try {
        this.agentProc.kill('SIGTERM');
      } catch {
        /* yoksay */
      }
      this.agentProc = null;
    }
    this.connected = false;
  }

  // ---------------------------------------------------------------- HTTP

  private request(pathname: string, method: 'GET' | 'POST', body?: unknown): Promise<ControlResult> {
    return new Promise((resolve) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = http.request(
        {
          host: '127.0.0.1',
          port: this.port,
          path: pathname,
          method,
          timeout: method === 'POST' && pathname === '/listen' ? 20000 : 5000,
          headers: payload
            ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
            : {},
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (raw += chunk));
          res.on('end', () => {
            let data: unknown = raw;
            try {
              data = raw ? JSON.parse(raw) : null;
            } catch {
              /* düz metin yanıt */
            }
            resolve({
              ok: (res.statusCode || 500) < 400,
              status: res.statusCode,
              data,
            });
          });
        }
      );
      req.on('timeout', () => {
        req.destroy(new Error('zaman aşımı'));
      });
      req.on('error', (error: Error) => resolve({ ok: false, error: error.message }));
      if (payload) req.write(payload);
      req.end();
    });
  }

  async state(): Promise<ControlResult> {
    return this.request('/state', 'GET');
  }

  async listen(enabled: boolean): Promise<ControlResult> {
    const result = await this.request('/listen', 'POST', { enabled });
    if (!result.ok && result.error) {
      logger.warn('Dinleme istegi basarisiz', { error: result.error });
    }
    return result;
  }

  async ask(text: string): Promise<ControlResult> {
    return this.request('/ask', 'POST', { text });
  }

  async confirm(confirmed: boolean): Promise<ControlResult> {
    return this.request('/confirm', 'POST', { confirmed });
  }

  /**
   * TTS'i çalışma zamanında açar/kapatır. `null` = ortam değişkenine dön.
   *
   * Ajan `ttsOverride` alanını değiştirir; süreç yeniden başlatılmaz.
   */
  async tts(enabled: boolean | null): Promise<ControlResult> {
    const result = await this.request('/tts', 'POST', { enabled });
    if (!result.ok) {
      logger.warn('TTS istegi basarisiz', { enabled, error: result.error });
    }
    return result;
  }

  // ---------------------------------------------------------------- agent process

  /** Ajan ayakta değilse arka planda başlatır; sağlık kontrolü bekler. */
  private async ensureAgent(): Promise<boolean> {
    const health = await this.request('/health', 'GET');
    if (health.ok) return true;
    if (this.spawning) return false;

    const root = this.findRoot();
    const entry = path.join(root, 'agent', 'dist', 'index.js');
    if (!fs.existsSync(entry)) {
      logger.error('Ajan giris dosyasi bulunamadi', { entry });
      return false;
    }

    const nodeBin = this.findNode();
    this.spawning = true;
    try {
      const logPath = path.join(os.tmpdir(), 'diji-agent.log');
      const out = fs.openSync(logPath, 'a');
      logger.info('Ajan baslatiliyor', { node: nodeBin, entry, log: logPath });
      this.agentProc = spawn(nodeBin, [entry], {
        cwd: root,
        detached: false,
        stdio: ['ignore', out, out],
        env: {
          ...process.env,
          DIJI_AGENT_SPAWNED_BY_UI: '1',
          // Mikrofonu her zaman PipeWire üzerinden ('default') oku: ham
          // donanım cihazına (plughw:...) geçmek aygıtı tek başına ele
          // geçirir ve diğer tüm uygulamaların mikrofonunu keser.
          DIJI_AUDIO_INPUT_DEVICE: process.env.DIJI_AUDIO_INPUT_DEVICE || 'default',
        },
      });
      this.agentProc.on('exit', (code, signal) => {
        logger.warn('Ajan sureci kapandi', { code, signal });
        this.agentProc = null;
        this.setConnected(false);
      });
    } catch (error) {
      logger.error('Ajan baslatilamadi', { error: (error as Error).message });
      this.spawning = false;
      return false;
    } finally {
      this.spawning = false;
    }

    // Model yüklemesi 10-20 s sürebilir: 30 s boyunca hazır olmasını bekle.
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      if (this.stopped) return false;
      const ping = await this.request('/health', 'GET');
      if (ping.ok) {
        logger.info('Ajan hazir', { port: this.port });
        return true;
      }
    }
    logger.error('Ajan zamaninda hazir olmadi', { port: this.port });
    return false;
  }

  /** Depo kökünü bulur (geliştirme ve paketlenmiş uygulama için). */
  private findRoot(): string {
    const fromEnv = process.env.DIJI_ROOT;
    const candidates = [
      fromEnv,
      path.resolve(process.cwd()),
      path.resolve(__dirname, '..', '..', '..'),
      path.resolve(__dirname, '..', '..', '..', '..'),
      path.join(os.homedir(), 'Documents', 'Jarvis_V1'),
    ].filter((c): c is string => Boolean(c));

    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, 'agent', 'dist', 'index.js'))) {
        return candidate;
      }
    }
    return candidates[candidates.length - 1] || process.cwd();
  }

  /** `node` çalıştırılabilirini PATH üzerinde arar (Electron kendi exe'sini vermez). */
  private findNode(): string {
    if (process.env.DIJI_NODE_BIN) return process.env.DIJI_NODE_BIN;
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
      const bin = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
      try {
        if (fs.existsSync(bin) && fs.statSync(bin).isFile()) return bin;
      } catch {
        /* yoksay */
      }
    }
    return 'node';
  }

  // ---------------------------------------------------------------- SSE

  private setConnected(value: boolean): void {
    if (this.connected === value) return;
    this.connected = value;
    this.emit({ type: 'link', connected: value, port: this.port });
  }

  private emit(payload: unknown): void {
    const win = this.getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('diji:telemetry', payload);
    }
  }

  private connectStream(): void {
    if (this.stopped) return;
    const req = http.get(
      { host: '127.0.0.1', port: this.port, path: '/events', headers: { Accept: 'text/event-stream' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          this.scheduleReconnect();
          return;
        }
        logger.info('Ajan telemetri akisina baglandi', { port: this.port });
        this.setConnected(true);

        // İlk bağlantıda mutlak TTS durumunu al: ajan zaten çalışıyordu ve
        // `tts-toggle` olayı biz bağlanmadan önce yayınlanmış olabilir.
        void this.state().then((result) => {
          const data = result?.data as { ttsEnabled?: boolean } | undefined;
          if (typeof data?.ttsEnabled === 'boolean') {
            this.ttsChangeListener?.(data.ttsEnabled);
          }
        });

        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLine = block
              .split('\n')
              .find((line) => line.startsWith('data: '));
            if (!dataLine) continue;
            try {
              const evt = JSON.parse(dataLine.slice(6)) as {
                type?: string;
                enabled?: boolean;
                stages?: unknown;
              };
              // TTS anahtarı olayı: tray onay kutusunu anında senkronla.
              if (evt?.type === 'tts-toggle' && typeof evt.enabled === 'boolean') {
                this.ttsChangeListener?.(evt.enabled);
              }
              // SSE 'snapshot' çerçevesinde tam durum gelir.
              if (evt?.stages && typeof (evt as { ttsEnabled?: unknown }).ttsEnabled === 'boolean') {
                this.ttsChangeListener?.((evt as { ttsEnabled: boolean }).ttsEnabled);
              }
              this.emit(evt);
            } catch {
              /* bozuk çerçeve yoksay */
            }
          }
        });
        res.on('end', () => {
          this.setConnected(false);
          this.scheduleReconnect();
        });
        res.on('error', () => {
          this.setConnected(false);
          this.scheduleReconnect();
        });
      }
    );
    this.sseRequest = req;
    req.on('error', () => {
      this.setConnected(false);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureAgent().then(() => this.connectStream());
    }, 3000);
  }
}
