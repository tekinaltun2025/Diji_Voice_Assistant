import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import {
  MCPServerConfig,
  MCPCallRequest,
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
 * Gmail OAuth2 konfigurasyonu
 */
const GMAIL_OAUTH_CONFIG: OAuth2Config = {
  clientId: process.env.GMAIL_CLIENT_ID || '',
  clientSecret: process.env.GMAIL_CLIENT_SECRET || '',
  redirectUri: process.env.GMAIL_REDIRECT_URI || 'http://localhost:3000/auth/gmail/callback',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scope: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.labels',
  ],
};

/**
 * Gmail MCP Server - Diji voice assistant icin
 * Islenen araclar: search_emails, read_email, send_email, list_labels
 */
export class GmailMCPServer {
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
    this.rateLimiter = new RateLimiter(100, 10); // 100 token, saniyede 10 refill
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    logger.info('Gmail MCP Server baslatiliyor');

    this.oauth2Client = new OAuth2Client(
      GMAIL_OAUTH_CONFIG.clientId,
      GMAIL_OAUTH_CONFIG.clientSecret,
      GMAIL_OAUTH_CONFIG.redirectUri
    );

    this.isInitialized = true;
    logger.info('Gmail MCP Server baslatildi');
  }

  /**
   * Kullanici icin Gmail API istemcisini hazirlar (token yenileme ile)
   */
  private async getGmailClient(userId: string): Promise<gmail_v1.Gmail | null> {
    if (!this.oauth2Client) {
      logger.error('OAuth2 istemcisi baslatilmamis');
      return null;
    }

    const token = this.tokenManager.getToken(userId, 'gmail');
    if (!token) {
      logger.warn('Gmail token bulunamadi', { userId });
      return null;
    }

    // Token gecerli degilse yenileme dene
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
          scope: GMAIL_OAUTH_CONFIG.scope.join(' '),
        };
        this.tokenManager.saveToken(userId, 'gmail', newToken);
        this.oauth2Client.setCredentials(newToken);
      } catch (error) {
        logger.error('Gmail token yenilenemedi', error instanceof Error ? error : undefined);
        return null;
      }
    } else {
      this.oauth2Client.setCredentials({
        access_token: token.access_token,
        refresh_token: token.refresh_token,
      });
    }

    return google.gmail({ version: 'v1', auth: this.oauth2Client });
  }

  /**
   * Tüm MCP araclari ve handler'larini kaydeder
   */
  registerTools(server: Server): void {
    // search_emails - read izni
    registerLegacyTool(server, 
      {
        method: 'tools/call',
        paramsSchema: z.object({
          name: z.literal('search_emails'),
          arguments: z.object({
            query: z.string().optional().default(''),
            maxResults: z.number().optional().default(10),
            userId: z.string(),
            sessionId: z.string(),
          }),
        }),
      },
      async (request) => {
        const { query, maxResults, userId, sessionId } = request.params.arguments;

        // Rate limiting
        if (!this.rateLimiter.consume(1)) {
          return {
            success: false,
            error: 'Islem cok fazla. Lutfen biraz bekleyin.',
          };
        }

        // Permission gate
        const gateResult = this.permissionGate.evaluate(
          { server: 'gmail', tool: 'search_emails', arguments: { query, maxResults }, userId, sessionId },
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

        const gmail = await this.getGmailClient(userId);
        if (!gmail) {
          return {
            success: false,
            error: 'Gmail kimlik dogrulama gerekli. Lutfen once OAuth2 ile giris yapin.',
          };
        }

        try {
          const response = await gmail.users.messages.list({
            userId: 'me',
            q: query,
            maxResults: Math.min(maxResults, 50),
          });

          const messages = response.data.messages || [];
          const emailList = await Promise.all(
            messages.map(async (msg) => {
              if (!msg.id) return null;
              const detail = await gmail.users.messages.get({
                userId: 'me',
                id: msg.id,
                format: 'metadata',
                metadataHeaders: ['From', 'To', 'Subject', 'Date'],
              });
              const headers = detail.data.payload?.headers || [];
              const getHeader = (name: string) =>
                headers.find((h) => h.name === name)?.value || '';
              return {
                id: msg.id,
                threadId: detail.data.threadId,
                from: getHeader('From'),
                to: getHeader('To'),
                subject: getHeader('Subject'),
                date: getHeader('Date'),
                snippet: detail.data.snippet || '',
              };
            })
          );

          return {
            success: true,
            data: {
              emails: emailList.filter(Boolean),
              total: messages.length,
              query,
            },
          };
        } catch (error) {
          logger.error('Gmail arama hatasi', error instanceof Error ? error : undefined);
          return {
            success: false,
            error: 'E-posta aranirken hata olustu: ' + (error instanceof Error ? error.message : String(error)),
          };
        }
      }
    );

    // read_email - read izni
    registerLegacyTool(server, 
      {
        method: 'tools/call',
        paramsSchema: z.object({
          name: z.literal('read_email'),
          arguments: z.object({
            messageId: z.string(),
            userId: z.string(),
            sessionId: z.string(),
          }),
        }),
      },
      async (request) => {
        const { messageId, userId, sessionId } = request.params.arguments;

        if (!this.rateLimiter.consume(1)) {
          return {
            success: false,
            error: 'Islem cok fazla. Lutfen biraz bekleyin.',
          };
        }

        const gateResult = this.permissionGate.evaluate(
          { server: 'gmail', tool: 'read_email', arguments: { messageId }, userId, sessionId },
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

        const gmail = await this.getGmailClient(userId);
        if (!gmail) {
          return {
            success: false,
            error: 'Gmail kimlik dogrulama gerekli.',
          };
        }

        try {
          const response = await gmail.users.messages.get({
            userId: 'me',
            id: messageId,
            format: 'full',
          });

          const message = response.data;
          const headers = message.payload?.headers || [];
          const getHeader = (name: string) =>
            headers.find((h) => h.name === name)?.value || '';

          return {
            success: true,
            data: {
              id: message.id,
              threadId: message.threadId,
              from: getHeader('From'),
              to: getHeader('To'),
              subject: getHeader('Subject'),
              date: getHeader('Date'),
              body: message.snippet || '',
              labels: message.labelIds || [],
            },
          };
        } catch (error) {
          logger.error('Gmail okuma hatasi', error instanceof Error ? error : undefined);
          return {
            success: false,
            error: 'E-posta okunurken hata olustu: ' + (error instanceof Error ? error.message : String(error)),
          };
        }
      }
    );

    // send_email - write izni (onay gerektirir)
    registerLegacyTool(server, 
      {
        method: 'tools/call',
        paramsSchema: z.object({
          name: z.literal('send_email'),
          arguments: z.object({
            to: z.string(),
            subject: z.string(),
            body: z.string(),
            userId: z.string(),
            sessionId: z.string(),
          }),
        }),
      },
      async (request) => {
        const { to, subject, body, userId, sessionId } = request.params.arguments;

        if (!this.rateLimiter.consume(1)) {
          return {
            success: false,
            error: 'Islem cok fazla. Lutfen biraz bekleyin.',
          };
        }

        const gateResult = this.permissionGate.evaluate(
          { server: 'gmail', tool: 'send_email', arguments: { to, subject, body }, userId, sessionId },
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

        // Write islemleri onay gerektirir
        if (gateResult.requiresConfirmation && gateResult.confirmationToken) {
          return permissionGateToResponse(gateResult, {
            message: 'E-posta gonderme onay bekliyor',
            to,
            subject,
            body,
          });
        }

        const gmail = await this.getGmailClient(userId);
        if (!gmail) {
          return {
            success: false,
            error: 'Gmail kimlik dogrulama gerekli.',
          };
        }

        try {
          const emailContent = [
            'To: ' + to,
            'Subject: ' + subject,
            'Content-Type: text/plain; charset=UTF-8',
            '',
            body,
          ].join('\n');

          const encodedEmail = Buffer.from(emailContent)
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');

          await gmail.users.messages.send({
            userId: 'me',
            requestBody: {
              raw: encodedEmail,
            },
          });

          return {
            success: true,
            data: {
              message: 'E-posta basariyla gonderildi',
              to,
              subject,
            },
          };
        } catch (error) {
          logger.error('Gmail gonderme hatasi', error instanceof Error ? error : undefined);
          return {
            success: false,
            error: 'E-posta gonderilirken hata olustu: ' + (error instanceof Error ? error.message : String(error)),
          };
        }
      }
    );

    // list_labels - read izni
    registerLegacyTool(server, 
      {
        method: 'tools/call',
        paramsSchema: z.object({
          name: z.literal('list_labels'),
          arguments: z.object({
            userId: z.string(),
            sessionId: z.string(),
          }),
        }),
      },
      async (request) => {
        const { userId, sessionId } = request.params.arguments;

        if (!this.rateLimiter.consume(1)) {
          return {
            success: false,
            error: 'Islem cok fazla. Lutfen biraz bekleyin.',
          };
        }

        const gateResult = this.permissionGate.evaluate(
          { server: 'gmail', tool: 'list_labels', arguments: {}, userId, sessionId },
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

        const gmail = await this.getGmailClient(userId);
        if (!gmail) {
          return {
            success: false,
            error: 'Gmail kimlik dogrulama gerekli.',
          };
        }

        try {
          const response = await gmail.users.labels.list({
            userId: 'me',
          });

          return {
            success: true,
            data: {
              labels: response.data.labels || [],
            },
          };
        } catch (error) {
          logger.error('Gmail etiket listeleme hatasi', error instanceof Error ? error : undefined);
          return {
            success: false,
            error: 'Etiketler listelenirken hata olustu: ' + (error instanceof Error ? error.message : String(error)),
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
      scope: GMAIL_OAUTH_CONFIG.scope,
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

    this.tokenManager.saveToken(userId, 'gmail', token);
    return token;
  }

  async dispose(): Promise<void> {
    this.isInitialized = false;
    logger.info('Gmail MCP Server kapatildi');
  }
}

// --- stdio entrypoint (otomatik eklendi) ---
async function main(): Promise<void> {
  const config = readServerConfigFromEnv('gmail');
  const server = new Server(
    { name: 'diji-gmail', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  const instance = new GmailMCPServer(config);
  await instance.initialize();
  instance.registerTools(server);

  await runMcpServerStdio(
    server,
    { name: 'diji-gmail', version: '1.0.0' },
    () => instance.dispose()
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error('GmailMCPServer baslatilamadi', error);
    process.exit(1);
  });
}

export { main };
