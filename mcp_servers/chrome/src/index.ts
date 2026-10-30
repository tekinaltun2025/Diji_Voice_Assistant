import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  MCPServerConfig,
  MCPCallResponse,
} from '@diji/shared';
import { logger, PermissionGate, permissionGateToResponse } from '@diji/shared';
import { RateLimiter } from '@diji/shared';
import { registerLegacyTool } from '@diji/shared';
import { runMcpServerStdio, readServerConfigFromEnv } from '@diji/shared/mcp-server';

/**
 * Chrome MCP Server - Diji voice assistant icin
 * Yerel Chrome yer imleri, gecmisi ve sekmelerle calisir
 * Islenen araclar: get_bookmarks, get_history, open_url, search_tabs
 */
export class ChromeMCPServer {
  private config: MCPServerConfig;
  private isInitialized: boolean = false;
  private permissionGate: PermissionGate;
  private rateLimiter: RateLimiter;

  constructor(config: MCPServerConfig) {
    this.config = config;
    this.permissionGate = new PermissionGate();
    this.rateLimiter = new RateLimiter(100, 10);
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    logger.info('Chrome MCP Server baslatiliyor');
    this.isInitialized = true;
    logger.info('Chrome MCP Server baslatildi');
  }

  /**
   * Chrome yer imleri dosyasini okur (Linux/macOS/Windows)
   */
  private getBookmarksFilePath(): string {
    const os = require('os');
    const homedir = os.homedir();
    const platform = os.platform();

    if (platform === 'darwin') {
      return `${homedir}/Library/Application Support/Google/Chrome/Default/Bookmarks`;
    } else if (platform === 'win32') {
      return `${homedir}/AppData/Local/Google/Chrome/User Data/Default/Bookmarks`;
    } else {
      return `${homedir}/.config/google-chrome/Default/Bookmarks`;
    }
  }

  /**
   * Chrome gecmisi dosyasini okur
   */
  private getHistoryFilePath(): string {
    const os = require('os');
    const homedir = os.homedir();
    const platform = os.platform();

    if (platform === 'darwin') {
      return `${homedir}/Library/Application Support/Google/Chrome/Default/History`;
    } else if (platform === 'win32') {
      return `${homedir}/AppData/Local/Google/Chrome/User Data/Default/History`;
    } else {
      return `${homedir}/.config/google-chrome/Default/History`;
    }
  }

  /**
   * Tüm MCP araclari ve handler'larini kaydeder
   */
  registerTools(server: Server): void {
    // get_bookmarks - read izni
    registerLegacyTool(server, 
      {
        method: 'tools/call',
        paramsSchema: z.object({
          name: z.literal('get_bookmarks'),
          arguments: z.object({
            folder: z.string().optional().default('kitapliklar'),
            userId: z.string(),
            sessionId: z.string(),
          }),
        }),
      },
      async (request) => {
        const { folder, userId, sessionId } = request.params.arguments as any;

        if (!this.rateLimiter.consume(1)) {
          return {
            success: false,
            error: 'Islem cok fazla. Lutfen biraz bekleyin.',
          };
        }

        const gateResult = this.permissionGate.evaluate(
          { server: 'chrome', tool: 'get_bookmarks', arguments: { folder }, userId, sessionId },
          'read',
          {
            readEnabled: this.config.permissions.read,
            writeEnabled: this.config.permissions.write,
            deleteEnabled: this.config.permissions.delete,
            requiresVoiceConfirmation: this.config.requiresVoiceConfirmation,
          }
        );

        if (!gateResult.allowed) {
          return permissionGateToResponse(gateResult);
        }

        try {
          const fs = require('fs');
          const bookmarksPath = this.getBookmarksFilePath();

          if (!fs.existsSync(bookmarksPath)) {
            return {
              success: false,
              error: 'Chrome yer imleri dosyasi bulunamadi',
            };
          }

          const bookmarksData = JSON.parse(fs.readFileSync(bookmarksPath, 'utf8'));
          const roots = bookmarksData.roots || {};

          const extractBookmarks = (node: any, result: any[] = []): any[] => {
            if (node.type === 'url') {
              result.push({
                id: node.id,
                name: node.name,
                url: node.url,
                dateAdded: node.date_added,
              });
            } else if (node.children) {
              for (const child of node.children) {
                extractBookmarks(child, result);
              }
            }
            return result;
          };

          const allBookmarks: any[] = [];
          for (const [key, root] of Object.entries(roots)) {
            if (root && typeof root === 'object') {
              extractBookmarks(root, allBookmarks);
            }
          }

          return {
            success: true,
            data: {
              bookmarks: allBookmarks,
              total: allBookmarks.length,
              folder,
            },
          };
        } catch (error) {
          logger.error('Chrome yer imleri okuma hatasi', error instanceof Error ? error : undefined);
          return {
            success: false,
            error: 'Yer imleri okunurken hata olustu: ' + (error instanceof Error ? error.message : String(error)),
          };
        }
      }
    );

    // get_history - read izni
    registerLegacyTool(server, 
      {
        method: 'tools/call',
        paramsSchema: z.object({
          name: z.literal('get_history'),
          arguments: z.object({
            maxResults: z.number().optional().default(50),
            startTime: z.string().optional(),
            endTime: z.string().optional(),
            userId: z.string(),
            sessionId: z.string(),
          }),
        }),
      },
      async (request) => {
        const { maxResults, startTime, endTime, userId, sessionId } = request.params.arguments as any;

        if (!this.rateLimiter.consume(1)) {
          return {
            success: false,
            error: 'Islem cok fazla. Lutfen biraz bekleyin.',
          };
        }

        const gateResult = this.permissionGate.evaluate(
          { server: 'chrome', tool: 'get_history', arguments: { maxResults, startTime, endTime }, userId, sessionId },
          'read',
          {
            readEnabled: this.config.permissions.read,
            writeEnabled: this.config.permissions.write,
            deleteEnabled: this.config.permissions.delete,
            requiresVoiceConfirmation: this.config.requiresVoiceConfirmation,
          }
        );

        if (!gateResult.allowed) {
          return permissionGateToResponse(gateResult);
        }

        try {
          const fs = require('fs');
          const historyPath = this.getHistoryFilePath();

          if (!fs.existsSync(historyPath)) {
            return {
              success: false,
              error: 'Chrome gecmisi dosyasi bulunamadi',
            };
          }

          // Chrome gecmisi SQLite veritabanidir, basit bir okuma simulasyonu
          // Gerçek implementasyonda better-sqlite3 kullanilabilir
          return {
            success: true,
            data: {
              history: [],
              total: 0,
              message: 'Chrome gecmisi okuma icin SQLite erisimi gereklidir',
              note: 'Bu ozellik better-sqlite3 paketi ile gerceklestirilebilir',
            },
          };
        } catch (error) {
          logger.error('Chrome gecmisi okuma hatasi', error instanceof Error ? error : undefined);
          return {
            success: false,
            error: 'Gecmis okunurken hata olustu: ' + (error instanceof Error ? error.message : String(error)),
          };
        }
      }
    );

    // open_url - write izni (onay gerektirir)
    registerLegacyTool(server, 
      {
        method: 'tools/call',
        paramsSchema: z.object({
          name: z.literal('open_url'),
          arguments: z.object({
            url: z.string().url(),
            userId: z.string(),
            sessionId: z.string(),
          }),
        }),
      },
      async (request) => {
        const { url, userId, sessionId } = request.params.arguments as any;

        if (!this.rateLimiter.consume(1)) {
          return {
            success: false,
            error: 'Islem cok fazla. Lutfen biraz bekleyin.',
          };
        }

        const gateResult = this.permissionGate.evaluate(
          { server: 'chrome', tool: 'open_url', arguments: { url }, userId, sessionId },
          'write',
          {
            readEnabled: this.config.permissions.read,
            writeEnabled: this.config.permissions.write,
            deleteEnabled: this.config.permissions.delete,
            requiresVoiceConfirmation: this.config.requiresVoiceConfirmation,
          }
        );

        if (!gateResult.allowed) {
          return permissionGateToResponse(gateResult);
        }

        if (gateResult.requiresConfirmation && gateResult.confirmationToken) {
          return permissionGateToResponse(gateResult, {
            message: 'URL acma onay bekliyor',
            url,
          });
        }

        try {
          const { exec } = require('child_process');
          const os = require('os');
          const platform = os.platform();

          let command: string;
          if (platform === 'darwin') {
            command = `open "${url}"`;
          } else if (platform === 'win32') {
            command = `start "" "${url}"`;
          } else {
            command = `xdg-open "${url}"`;
          }

          exec(command, (error: any) => {
            if (error) {
              logger.error('URL acma hatasi', error);
            }
          });

          return {
            success: true,
            data: {
              url,
              message: 'URL basariyla acildi',
            },
          };
        } catch (error) {
          logger.error('URL acma hatasi', error instanceof Error ? error : undefined);
          return {
            success: false,
            error: 'URL acilirken hata olustu: ' + (error instanceof Error ? error.message : String(error)),
          };
        }
      }
    );

    // search_tabs - read izni
    registerLegacyTool(server, 
      {
        method: 'tools/call',
        paramsSchema: z.object({
          name: z.literal('search_tabs'),
          arguments: z.object({
            query: z.string().optional().default(''),
            userId: z.string(),
            sessionId: z.string(),
          }),
        }),
      },
      async (request) => {
        const { query, userId, sessionId } = request.params.arguments as any;

        if (!this.rateLimiter.consume(1)) {
          return {
            success: false,
            error: 'Islem cok fazla. Lutfen biraz bekleyin.',
          };
        }

        const gateResult = this.permissionGate.evaluate(
          { server: 'chrome', tool: 'search_tabs', arguments: { query }, userId, sessionId },
          'read',
          {
            readEnabled: this.config.permissions.read,
            writeEnabled: this.config.permissions.write,
            deleteEnabled: this.config.permissions.delete,
            requiresVoiceConfirmation: this.config.requiresVoiceConfirmation,
          }
        );

        if (!gateResult.allowed) {
          return permissionGateToResponse(gateResult);
        }

        try {
          // Chrome sekmelerine erisim icin Chrome Debugging Protocol veya uzanti gerekir
          // Basit bir simulasyon dondurulur
          return {
            success: true,
            data: {
              tabs: [],
              total: 0,
              query,
              message: 'Sekme arama icin Chrome Debugging Protocol gereklidir',
              note: 'Bu ozellik Chrome uzantisi ile gerceklestirilebilir',
            },
          };
        } catch (error) {
          logger.error('Chrome sekme arama hatasi', error instanceof Error ? error : undefined);
          return {
            success: false,
            error: 'Sekmeler aranirken hata olustu: ' + (error instanceof Error ? error.message : String(error)),
          };
        }
      }
    );
  }

  async dispose(): Promise<void> {
    this.isInitialized = false;
    logger.info('Chrome MCP Server kapatildi');
  }
}

// --- stdio entrypoint (otomatik eklendi) ---
async function main(): Promise<void> {
  const config = readServerConfigFromEnv('chrome');
  const server = new Server(
    { name: 'diji-chrome', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  const instance = new ChromeMCPServer(config);
  await instance.initialize();
  instance.registerTools(server);

  await runMcpServerStdio(
    server,
    { name: 'diji-chrome', version: '1.0.0' },
    () => instance.dispose()
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error('ChromeMCPServer baslatilamadi', error);
    process.exit(1);
  });
}

export { main };
