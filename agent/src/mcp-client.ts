import { ChildProcess, spawn } from 'child_process';
import {
  MCPServerConfig,
  MCPTool,
  MCPCallRequest,
  MCPCallResponse,
  MCPServerName,
  MCPPermission,
} from '@diji/shared';
import { logInfo, logError, logDebug, logWarn } from '@diji/shared';

export type PermissionGate = 'read' | 'write' | 'delete';

export interface MCPServerConnection {
  name: MCPServerName;
  config: MCPServerConfig;
  isConnected: boolean;
  tools: MCPTool[];
  client: ChildProcess | null;
  /** Artimli JSON-RPC tamponu */
  buffer: string;
  /** Bekleyen istekler: id -> cozucu */
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  nextId: number;
  initialized: boolean;
}

export interface VoiceConfirmationRequest {
  server: MCPServerName;
  tool: string;
  arguments: Record<string, unknown>;
  permission: MCPPermission;
  reason: string;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpListToolsResult {
  tools?: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
}

interface McpCallToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

const PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Gercek MCP (Model Context Protocol) istemcisi.
 *
 * Her MCP sunucusu ayri bir alt surec olarak baslatilir ve JSON-RPC 2.0
 * protokolu stdio uzerinden konusulur. Tool listesi sunucudan canli olarak
 * alinir; sabit/sahte bir liste kullanilmaz.
 */
export class MCPClient {
  private servers: Map<MCPServerName, MCPServerConnection> = new Map();
  private isInitialized = false;
  private voiceConfirmationCallback:
    | ((request: VoiceConfirmationRequest) => Promise<boolean>)
    | null = null;
  private defaultPermissionGate: {
    read: boolean;
    write: boolean;
    delete: boolean;
  };

  constructor(permissionGate?: {
    read: boolean;
    write: boolean;
    delete: boolean;
  }) {
    this.defaultPermissionGate = permissionGate || {
      read: true,
      write: true,
      delete: false,
    };
  }

  async initialize(serverConfigs: MCPServerConfig[]): Promise<void> {
    if (this.isInitialized) return;

    logInfo('MCP Client baslatiliyor', {
      serverCount: serverConfigs.length,
      permissionGate: this.defaultPermissionGate,
    });

    for (const config of serverConfigs) {
      await this.registerServer(config);
    }

    this.isInitialized = true;
    logInfo('MCP Client hazir', {
      connectedServers: this.getConnectedServerNames(),
      totalTools: this.getAllTools().length,
    });
  }

  private async registerServer(config: MCPServerConfig): Promise<void> {
    const connection: MCPServerConnection = {
      name: config.name,
      config,
      isConnected: false,
      tools: [],
      client: null,
      buffer: '',
      pending: new Map(),
      nextId: 1,
      initialized: false,
    };

    this.servers.set(config.name, connection);

    if (config.enabled) {
      await this.connectServer(connection);
    } else {
      logDebug('MCP sunucusu devre disi', { name: config.name });
    }
  }

  private async connectServer(connection: MCPServerConnection): Promise<void> {
    const { config } = connection;

    try {
      logInfo('MCP sunucusu baslatiliyor', {
        name: config.name,
        command: config.command,
      });

      const child = spawn(config.command, config.args ?? [], {
        env: { ...process.env, ...config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      connection.client = child;

      child.stdout?.on('data', (data: Buffer) => {
        this.handleStdout(connection, data.toString('utf8'));
      });

      child.stderr?.on('data', (data: Buffer) => {
        logWarn(`MCP ${config.name} stderr`, {
          data: data.toString('utf8').substring(0, 500),
        });
      });

      child.on('error', (error: Error) => {
        logError(`MCP sunucusu calistirilamadi: ${config.name}`, error);
        connection.isConnected = false;
        this.rejectAllPending(connection, error);
      });

      child.on('close', (code: number | null) => {
        if (connection.isConnected) {
          logWarn(`MCP sunucusu kapandi: ${config.name}`, { code });
        }
        connection.isConnected = false;
        connection.initialized = false;
        this.rejectAllPending(
          connection,
          new Error(`MCP sunucusu kapandi (${config.name}), kod: ${code}`)
        );
      });

      await this.sendRequest(connection, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: { name: 'diji-agent', version: '1.0.0' },
      });

      this.sendNotification(connection, 'notifications/initialized', {});

      connection.isConnected = true;
      connection.initialized = true;

      await this.fetchTools(connection);

      logInfo('MCP sunucusuna baglanildi', {
        name: config.name,
        toolCount: connection.tools.length,
      });
    } catch (error) {
      logError(`MCP sunucusuna baglanilamadi: ${config.name}`, error as Error);
      connection.isConnected = false;
      this.terminate(connection);
    }
  }

  /** Alt surecten gelen veriyi satirlara bolup JSON-RPC mesajlarini isler. */
  private handleStdout(connection: MCPServerConnection, chunk: string): void {
    connection.buffer += chunk;

    let newlineIndex = connection.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = connection.buffer.slice(0, newlineIndex).trim();
      connection.buffer = connection.buffer.slice(newlineIndex + 1);
      newlineIndex = connection.buffer.indexOf('\n');

      if (!line) continue;

      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        logDebug(`MCP ${connection.name} JSON olmayan cikti`, {
          line: line.substring(0, 200),
        });
        continue;
      }

      if (typeof message.id !== 'number') {
        // Sunucudan gelen bildirim (notification) — simdilik yalnizca logla
        logDebug(`MCP ${connection.name} bildirimi`, { message });
        continue;
      }

      const pending = connection.pending.get(message.id);
      if (!pending) {
        logDebug(`MCP ${connection.name} eslesmeyen yanit`, { id: message.id });
        continue;
      }

      connection.pending.delete(message.id);

      if (message.error) {
        pending.reject(
          new Error(`MCP hatasi: ${message.error.message} (kod ${message.error.code})`)
        );
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private sendRequest(
    connection: MCPServerConnection,
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    // stdin referansini yerel degiskene aliyoruz: TypeScript daraltmasi
    // Promise executor closure'i icine tasinmaz, bu yuzden null kontrolu
    // burada tek seferlik yapilir ve closure icinde non-null tip kullanilir.
    const stdin = connection.client?.stdin;
    if (!stdin || stdin.destroyed) {
      return Promise.reject(new Error(`MCP sunucusu bagli degil: ${connection.name}`));
    }

    const id = connection.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(id);
        reject(
          new Error(`MCP istegi zaman asimina ugradi: ${method} (${connection.name})`)
        );
      }, REQUEST_TIMEOUT_MS);

      connection.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      try {
        stdin.write(payload, (error) => {
          if (error) {
            connection.pending.delete(id);
            clearTimeout(timer);
            reject(error);
          }
        });
      } catch (error) {
        connection.pending.delete(id);
        clearTimeout(timer);
        reject(error as Error);
      }
    });
  }

  private sendNotification(
    connection: MCPServerConnection,
    method: string,
    params: Record<string, unknown>
  ): void {
    const stdin = connection.client?.stdin;
    if (!stdin || stdin.destroyed) return;

    try {
      stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch (error) {
      logWarn(`MCP bildirimi gonderilemedi: ${method}`, {
        error: (error as Error).message,
      });
    }
  }

  private rejectAllPending(connection: MCPServerConnection, error: Error): void {
    for (const [, pending] of connection.pending) {
      pending.reject(error);
    }
    connection.pending.clear();
  }

  private terminate(connection: MCPServerConnection): void {
    const child = connection.client;
    if (!child) return;

    try {
      if (!child.killed) child.kill();
    } catch (error) {
      logWarn(`MCP sunucusu sonlandirilamadi: ${connection.name}`, {
        error: (error as Error).message,
      });
    }
  }

  /** Sunucudan canli tool listesini alir ve izinleri siniflandirir. */
  private async fetchTools(connection: MCPServerConnection): Promise<void> {
    try {
      const result = (await this.sendRequest(connection, 'tools/list', {})) as McpListToolsResult;
      const rawTools = result?.tools ?? [];

      connection.tools = rawTools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? tool.name,
        inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
        server: connection.name,
        permission: this.inferPermission(tool.name),
      }));

      logDebug(`MCP ${connection.name} tool listesi`, {
        count: connection.tools.length,
        tools: connection.tools.map((t) => `${t.name}:${t.permission}`),
      });
    } catch (error) {
      logError(`MCP ${connection.name} tool listesi alinamadi`, error as Error);
      connection.tools = [];
    }
  }

  /**
   * Tool adindan izin seviyesini cikarir.
   *
   * Ad, `_` / `-` / `.` ile parcalanir ve TAM kelime eslesmesi aranir.
   * Boylece `open_url` yanlislikla "yazma" sayilmaz (icinde "open" var
   * diye degil, kelime listesinde olmadigi icin read kalir).
   *
   * Yazma fiilleri listesi bilincli olarak muhafazakardir: yalnizca
   * gercekten durum degistiren fiiller. Okuma fiilleri (get, list,
   * search, read, open, download...) varsayilan olarak read kabul edilir.
   */
  private inferPermission(toolName: string): MCPPermission {
    const tokens = toolName
      .toLowerCase()
      .split(/[._\-\s]+/)
      .filter((token) => token.length > 0);

    const DELETE_TOKENS = ['delete', 'remove', 'destroy', 'trash', 'purge', 'sil'];
    const WRITE_TOKENS = [
      'send',
      'create',
      'insert',
      'update',
      'write',
      'upload',
      'post',
      'add',
      'edit',
      'move',
      'rename',
      'set',
      'patch',
      'reply',
      'forward',
      'archive',
      'gonder',
      'olustur',
      'ekle',
      'guncelle',
      'yaz',
    ];

    if (tokens.some((token) => DELETE_TOKENS.includes(token))) {
      return 'delete';
    }
    if (tokens.some((token) => WRITE_TOKENS.includes(token))) {
      return 'write';
    }
    return 'read';
  }

  setVoiceConfirmationCallback(
    callback: (request: VoiceConfirmationRequest) => Promise<boolean>
  ): void {
    this.voiceConfirmationCallback = callback;
    logInfo('MCP ses onay callbacki ayarlandi');
  }

  async callTool(request: MCPCallRequest): Promise<MCPCallResponse> {
    if (!this.isInitialized) {
      throw new Error('MCP Client baslatilmamis');
    }

    const connection = this.servers.get(request.server);
    if (!connection) {
      return {
        success: false,
        error: `MCP sunucusu bulunamadi: ${request.server}`,
      };
    }

    if (!connection.isConnected) {
      return {
        success: false,
        error: `MCP sunucusu bagli degil: ${request.server}`,
      };
    }

    const tool = connection.tools.find((t) => t.name === request.tool);
    if (!tool) {
      return {
        success: false,
        error: `Tool bulunamadi: ${request.tool} (sunucu: ${request.server})`,
      };
    }

    const permissionCheck = this.checkPermission(tool.permission, request.server);
    if (!permissionCheck.allowed) {
      return {
        success: false,
        error: permissionCheck.reason,
        requiresConfirmation: permissionCheck.requiresConfirmation,
      };
    }

    if (tool.permission === 'write' || tool.permission === 'delete') {
      if (this.voiceConfirmationCallback) {
        const confirmed = await this.voiceConfirmationCallback({
          server: request.server,
          tool: request.tool,
          arguments: request.arguments,
          permission: tool.permission,
          reason: `${tool.permission} islemi icin ses onayi gerekiyor`,
        });

        if (!confirmed) {
          return {
            success: false,
            error: 'Kullanici tarafindan ses onayi reddedildi',
          };
        }
      } else {
        return {
          success: false,
          error: 'Ses onay callbacki ayarlanmamis, write/delete islemi engellendi',
          requiresConfirmation: true,
        };
      }
    }

    // Kullanici baglamini araca enjekte et
    const args: Record<string, unknown> = {
      ...request.arguments,
      userId: request.userId,
      sessionId: request.sessionId,
    };

    try {
      logInfo('MCP tool cagrisi yapiliyor', {
        server: request.server,
        tool: request.tool,
        permission: tool.permission,
      });

      const raw = (await this.sendRequest(connection, 'tools/call', {
        name: request.tool,
        arguments: args,
      })) as McpCallToolResult;

      const textContent = (raw?.content ?? [])
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('\n');

      // Sunucular hata durumunda da JSON dondurur; kullaniciya ham JSON
      // gostermek yerine icindeki `error` alanini cikar.
      const extractErrorMessage = (text: string): string => {
        try {
          const parsed = JSON.parse(text) as { error?: unknown };
          if (typeof parsed.error === 'string' && parsed.error.length > 0) {
            return parsed.error;
          }
        } catch {
          // duz metin: oldugu gibi kullan
        }
        return text || 'MCP araci hata dondurdu';
      };

      if (raw?.isError) {
        return {
          success: false,
          error: extractErrorMessage(textContent),
        };
      }

      // `isError` isaretlenmemis olsa da govdede success=false olabilir.
      try {
        const parsed = JSON.parse(textContent) as { success?: unknown; error?: unknown };
        if (parsed && parsed.success === false) {
          return {
            success: false,
            error:
              typeof parsed.error === 'string'
                ? parsed.error
                : 'MCP araci basarisiz sonuc dondurdu',
          };
        }
      } catch {
        // duz metin yanit: asagida basarili kabul edilir
      }

      // Sunucular sonucu JSON metni olarak dondurur; cozmeyi dene.
      let data: unknown = textContent;
      try {
        data = JSON.parse(textContent);
      } catch {
        // duz metin yanit: oldugu gibi kullan
      }

      logInfo('MCP tool cagrisi basarili', {
        server: request.server,
        tool: request.tool,
      });

      return { success: true, data };
    } catch (error) {
      logError('MCP tool cagrisi hatasi', error as Error, {
        server: request.server,
        tool: request.tool,
      });

      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  private checkPermission(
    permission: MCPPermission,
    serverName: MCPServerName
  ): { allowed: boolean; reason?: string; requiresConfirmation?: boolean } {
    const connection = this.servers.get(serverName);
    if (!connection) {
      return { allowed: false, reason: `Sunucu bulunamadi: ${serverName}` };
    }

    const serverPermission = connection.config.permissions[permission];
    const gatePermission = this.defaultPermissionGate[permission];

    if (!serverPermission || !gatePermission) {
      if (permission === 'delete') {
        return {
          allowed: false,
          reason: `Silme islemi engellendi: ${serverName}`,
        };
      }
      return {
        allowed: false,
        reason: `${permission} izni yok: ${serverName}`,
      };
    }

    if (permission === 'delete') {
      return { allowed: true, requiresConfirmation: true };
    }

    if (permission === 'write' && connection.config.requiresVoiceConfirmation) {
      return { allowed: true, requiresConfirmation: true };
    }

    return { allowed: true };
  }

  getServer(name: MCPServerName): MCPServerConnection | undefined {
    return this.servers.get(name);
  }

  getConnectedServerNames(): MCPServerName[] {
    return Array.from(this.servers.entries())
      .filter(([, conn]) => conn.isConnected)
      .map(([name]) => name);
  }

  /**
   * Her MCP sunucusunun CANLI durumu (arayüzdeki servis listesi için).
   *
   * Değerler sunucudan gerçekten alınmış araç sayısına ve stdio bağlantısının
   * açık olup olmamasına dayanır; sabit/mock liste yoktur. Hiç başlatılmamış
   * sunucu da listede yer alır (`connected: false`, `toolCount: 0`).
   */
  getServerStatuses(): Array<{
    name: MCPServerName;
    connected: boolean;
    toolCount: number;
    permissions: { read: boolean; write: boolean; delete: boolean };
  }> {
    const statuses: Array<{
      name: MCPServerName;
      connected: boolean;
      toolCount: number;
      permissions: { read: boolean; write: boolean; delete: boolean };
    }> = [];
    for (const [name, conn] of this.servers.entries()) {
      statuses.push({
        name,
        connected: conn.isConnected,
        toolCount: conn.tools.length,
        permissions: { ...conn.config.permissions },
      });
    }
    return statuses;
  }

  getAllTools(): MCPTool[] {
    const allTools: MCPTool[] = [];
    for (const connection of this.servers.values()) {
      allTools.push(...connection.tools);
    }
    return allTools;
  }

  getToolsByServer(serverName: MCPServerName): MCPTool[] {
    const connection = this.servers.get(serverName);
    return connection ? connection.tools : [];
  }

  getToolsByPermission(permission: MCPPermission): MCPTool[] {
    return this.getAllTools().filter((tool) => tool.permission === permission);
  }

  async disconnectServer(serverName: MCPServerName): Promise<void> {
    const connection = this.servers.get(serverName);
    if (!connection) return;

    this.rejectAllPending(connection, new Error(`Baglanti kapatildi: ${serverName}`));
    this.terminate(connection);
    connection.isConnected = false;
    connection.initialized = false;
    logInfo(`MCP sunucusundan baglanti kesildi: ${serverName}`);
  }

  async disconnectAll(): Promise<void> {
    for (const serverName of Array.from(this.servers.keys())) {
      await this.disconnectServer(serverName);
    }
  }

  async dispose(): Promise<void> {
    await this.disconnectAll();
    this.servers.clear();
    this.isInitialized = false;
    this.voiceConfirmationCallback = null;
    logInfo('MCP Client kapatildi');
  }
}

export const createMCPClient = (permissionGate?: {
  read: boolean;
  write: boolean;
  delete: boolean;
}): MCPClient => {
  return new MCPClient(permissionGate);
};
