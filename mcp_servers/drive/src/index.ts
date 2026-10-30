import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import type { drive_v3 } from 'googleapis';
import { z } from 'zod';
import {
  MCPServerConfig,
  MCPCallResponse,
  OAuth2Token,
  OAuth2Config,
} from '@diji/shared';
import { logger } from '@diji/shared';
import { OAuth2TokenManager } from '@diji/shared';
import { PermissionGate, permissionGateToResponse } from '@diji/shared';
import { RateLimiter } from '@diji/shared';
import { registerLegacyTool } from '@diji/shared';
import { runMcpServerStdio, readServerConfigFromEnv } from '@diji/shared/mcp-server';

/**
 * Google Drive OAuth2 konfigurasyonu
 */
const DRIVE_OAUTH_CONFIG: OAuth2Config = {
  clientId: process.env.DRIVE_CLIENT_ID || '',
  clientSecret: process.env.DRIVE_CLIENT_SECRET || '',
  redirectUri: process.env.DRIVE_REDIRECT_URI || 'http://localhost:3000/auth/drive/callback',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scope: [
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/drive.file',
  ],
};

/**
 * Drive MCP Server - Diji voice assistant icin
 * Islenen araclar: search_files, read_file, download_file, list_folder
 */
export class DriveMCPServer {
  private config: MCPServerConfig;
  private isInitialized: boolean = false;
  private oauth2Client: OAuth2Client | null = null;
  private tokenManager: OAuth2TokenManager;
  private permissionGate: PermissionGate;
  private rateLimiter: RateLimiter;

  constructor(config: MCPServerConfig) {
    this.config = config;
    this.tokenManager = new OAuth2TokenManager(
      process.env.TOKEN_STORAGE_PATH || './tokens',
      process.env.ENCRYPTION_PASSWORD || 'diji-default-key'
    );
    this.permissionGate = new PermissionGate();
    this.rateLimiter = new RateLimiter(100, 10);
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    logger.info('Drive MCP Server baslatiliyor');

    this.oauth2Client = new google.auth.OAuth2(
      DRIVE_OAUTH_CONFIG.clientId,
      DRIVE_OAUTH_CONFIG.clientSecret,
      DRIVE_OAUTH_CONFIG.redirectUri
    );

    this.isInitialized = true;
    logger.info('Drive MCP Server baslatildi');
  }

  /**
   * Kullanici icin Drive API istemcisini hazirlar
   */
  private async getDriveClient(userId: string): Promise<drive_v3.Drive | null> {
    if (!this.oauth2Client) {
      logger.error('OAuth2 istemcisi baslatilmamis');
      return null;
    }

    const token = this.tokenManager.getToken(userId, 'drive');
    if (!token) {
      logger.warn('Drive token bulunamadi', { userId });
      return null;
    }

    if (!this.tokenManager.isTokenValid(token) && token.refresh_token) {
      try {
        this.oauth2Client.setCredentials({
          refresh_token: token.refresh_token,
        });
        const { credentials } = await this.oauth2Client.refreshAccessToken();
        const newToken: OAuth2Token = {
          access_token: credentials.access_token || token.access_token,
          refresh_token: credentials.refresh_token || token.refresh_token,
          expires_at: credentials.expiry_date ? credentials.expiry_date : Date.now() + 3600000,
          scope: DRIVE_OAUTH_CONFIG.scope.join(' '),
        };
        this.tokenManager.saveToken(userId, 'drive', newToken);
        this.oauth2Client.setCredentials(newToken);
      } catch (error) {
        logger.error('Drive token yenilenemedi', error instanceof Error ? error : undefined);
        return null;
      }
    } else {
      this.oauth2Client.setCredentials({
        access_token: token.access_token,
        refresh_token: token.refresh_token,
      });
    }

    return google.drive({ version: 'v3', auth: this.oauth2Client });
  }

  /**
   * Tüm MCP araclari ve handler'larini kaydeder
   */
  registerTools(server: Server): void {
    // search_files - read izni
    registerLegacyTool(server, 
      {
        method: 'tools/call',
        paramsSchema: z.object({
          name: z.literal('search_files'),
          arguments: z.object({
            query: z.string().optional().default(''),
            maxResults: z.number().optional().default(10),
            userId: z.string(),
            sessionId: z.string(),
          }),
        }),
      },
      async (request) => {
        const { query, maxResults, userId, sessionId } = request.params.arguments as any;

        if (!this.rateLimiter.consume(1)) {
          return {
            success: false,
            error: 'Islem cok fazla. Lutfen biraz bekleyin.',
          };
        }

        const gateResult = this.permissionGate.evaluate(
          { server: 'drive', tool: 'search_files', arguments: { query, maxResults }, userId, sessionId },
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

        const drive = await this.getDriveClient(userId);
        if (!drive) {
          return {
            success: false,
            error: 'Drive kimlik dogrulama gerekli. Lutfen once OAuth2 ile giris yapin.',
          };
        }

        try {
          const response = await drive.files.list({
            q: query || undefined,
            pageSize: Math.min(maxResults, 50),
            fields: 'files(id, name, mimeType, size, createdTime, modifiedTime, webViewLink, parents)',
          });

          const files = response.data.files || [];
          return {
            success: true,
            data: {
              files: files.map((f) => ({
                id: f.id || '',
                name: f.name || '',
                mimeType: f.mimeType || '',
                size: f.size || '0',
                createdTime: f.createdTime || '',
                modifiedTime: f.modifiedTime || '',
                webViewLink: f.webViewLink || '',
                parents: f.parents || [],
              })),
              total: files.length,
              query,
            },
          };
        } catch (error) {
          logger.error('Drive dosya arama hatasi', error instanceof Error ? error : undefined);
          return {
            success: false,
            error: 'Dosyalar aranirken hata olustu: ' + (error instanceof Error ? error.message : String(error)),
          };
        }
      }
    );

    // read_file - read izni
    registerLegacyTool(server, 
      {
        method: 'tools/call',
        paramsSchema: z.object({
          name: z.literal('read_file'),
          arguments: z.object({
            fileId: z.string(),
            userId: z.string(),
            sessionId: z.string(),
          }),
        }),
      },
      async (request) => {
        const { fileId, userId, sessionId } = request.params.arguments as any;

        if (!this.rateLimiter.consume(1)) {
          return {
            success: false,
            error: 'Islem cok fazla. Lutfen biraz bekleyin.',
          };
        }

        const gateResult = this.permissionGate.evaluate(
          { server: 'drive', tool: 'read_file', arguments: { fileId }, userId, sessionId },
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

        const drive = await this.getDriveClient(userId);
        if (!drive) {
          return {
            success: false,
            error: 'Drive kimlik dogrulama gerekli.',
          };
        }

        try {
          const response = await drive.files.get({
            fileId,
            fields: 'id, name, mimeType, size, createdTime, modifiedTime, webViewLink',
          });

          const file = response.data;
          return {
            success: true,
            data: {
              id: file.id || '',
              name: file.name || '',
              mimeType: file.mimeType || '',
              size: file.size || '0',
              createdTime: file.createdTime || '',
              modifiedTime: file.modifiedTime || '',
              webViewLink: file.webViewLink || '',
            },
          };
        } catch (error) {
          logger.error('Drive dosya okuma hatasi', error instanceof Error ? error : undefined);
          return {
            success: false,
            error: 'Dosya okunurken hata olustu: ' + (error instanceof Error ? error.message : String(error)),
          };
        }
      }
    );

    // download_file - read izni
    registerLegacyTool(server, 
      {
        method: 'tools/call',
        paramsSchema: z.object({
          name: z.literal('download_file'),
          arguments: z.object({
            fileId: z.string(),
            userId: z.string(),
            sessionId: z.string(),
          }),
        }),
      },
      async (request) => {
        const { fileId, userId, sessionId } = request.params.arguments as any;

        if (!this.rateLimiter.consume(1)) {
          return {
            success: false,
            error: 'Islem cok fazla. Lutfen biraz bekleyin.',
          };
        }

        const gateResult = this.permissionGate.evaluate(
          { server: 'drive', tool: 'download_file', arguments: { fileId }, userId, sessionId },
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

        const drive = await this.getDriveClient(userId);
        if (!drive) {
          return {
            success: false,
            error: 'Drive kimlik dogrulama gerekli.',
          };
        }

        try {
          const response = await drive.files.get({
            fileId,
            alt: 'media',
          }, {
            responseType: 'arraybuffer',
          });

          const buffer = response.data as Buffer;
          const base64Content = buffer.toString('base64');

          return {
            success: true,
            data: {
              fileId,
              content: base64Content,
              encoding: 'base64',
              message: 'Dosya basariyla indirildi',
            },
          };
        } catch (error) {
          logger.error('Drive dosya indirme hatasi', error instanceof Error ? error : undefined);
          return {
            success: false,
            error: 'Dosya indirilirken hata olustu: ' + (error instanceof Error ? error.message : String(error)),
          };
        }
      }
    );

    // list_folder - read izni
    registerLegacyTool(server, 
      {
        method: 'tools/call',
        paramsSchema: z.object({
          name: z.literal('list_folder'),
          arguments: z.object({
            folderId: z.string().optional().default('root'),
            maxResults: z.number().optional().default(50),
            userId: z.string(),
            sessionId: z.string(),
          }),
        }),
      },
      async (request) => {
        const { folderId, maxResults, userId, sessionId } = request.params.arguments as any;

        if (!this.rateLimiter.consume(1)) {
          return {
            success: false,
            error: 'Islem cok fazla. Lutfen biraz bekleyin.',
          };
        }

        const gateResult = this.permissionGate.evaluate(
          { server: 'drive', tool: 'list_folder', arguments: { folderId, maxResults }, userId, sessionId },
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

        const drive = await this.getDriveClient(userId);
        if (!drive) {
          return {
            success: false,
            error: 'Drive kimlik dogrulama gerekli.',
          };
        }

        try {
          const response = await drive.files.list({
            q: `'${folderId}' in parents and trashed = false`,
            pageSize: Math.min(maxResults, 100),
            fields: 'files(id, name, mimeType, size, createdTime, modifiedTime, webViewLink)',
            orderBy: 'name',
          });

          const files = response.data.files || [];
          return {
            success: true,
            data: {
              folderId,
              files: files.map((f) => ({
                id: f.id || '',
                name: f.name || '',
                mimeType: f.mimeType || '',
                size: f.size || '0',
                createdTime: f.createdTime || '',
                modifiedTime: f.modifiedTime || '',
                webViewLink: f.webViewLink || '',
              })),
              total: files.length,
            },
          };
        } catch (error) {
          logger.error('Drive klasor listeleme hatasi', error instanceof Error ? error : undefined);
          return {
            success: false,
            error: 'Klasor listelenirken hata olustu: ' + (error instanceof Error ? error.message : String(error)),
          };
        }
      }
    );
  }

  /**
   * OAuth2 yetkilendirme URL'sini dondurur
   */
  getAuthUrl(userId: string): string {
    if (!this.oauth2Client) {
      throw new Error('OAuth2 istemcisi baslatilmamis');
    }
    const state = Buffer.from(userId).toString('base64');
    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: DRIVE_OAUTH_CONFIG.scope,
      state,
      prompt: 'consent',
    });
  }

  /**
   * OAuth2 callback'i isler ve token'i kaydeder
   */
  async handleOAuthCallback(userId: string, code: string): Promise<OAuth2Token> {
    if (!this.oauth2Client) {
      throw new Error('OAuth2 istemcisi baslatilmamis');
    }

    const { tokens } = await this.oauth2Client.getToken(code);
    const token: OAuth2Token = {
      access_token: tokens.access_token || '',
      refresh_token: tokens.refresh_token ?? undefined,
      expires_at: tokens.expiry_date ? tokens.expiry_date : Date.now() + 3600000,
      scope: tokens.scope ?? undefined,
      token_type: tokens.token_type ?? undefined,
    };

    this.tokenManager.saveToken(userId, 'drive', token);
    return token;
  }

  async dispose(): Promise<void> {
    this.isInitialized = false;
    logger.info('Drive MCP Server kapatildi');
  }
}

// --- stdio entrypoint (otomatik eklendi) ---
async function main(): Promise<void> {
  const config = readServerConfigFromEnv('drive');
  const server = new Server(
    { name: 'diji-drive', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  const instance = new DriveMCPServer(config);
  await instance.initialize();
  instance.registerTools(server);

  await runMcpServerStdio(
    server,
    { name: 'diji-drive', version: '1.0.0' },
    () => instance.dispose()
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error('DriveMCPServer baslatilamadi', error);
    process.exit(1);
  });
}

export { main };
