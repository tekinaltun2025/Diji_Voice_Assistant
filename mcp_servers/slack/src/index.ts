import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebClient } from '@slack/web-api';
import { z } from 'zod';
import {
  MCPServerConfig,
  MCPCallResponse,
} from '@diji/shared';
import { logger } from '@diji/shared';
import { OAuth2TokenManager } from '@diji/shared';
import { PermissionGate, permissionGateToResponse } from '@diji/shared';
import { RateLimiter } from '@diji/shared';
import { registerLegacyTool } from '@diji/shared';
import { runMcpServerStdio, readServerConfigFromEnv } from '@diji/shared/mcp-server';

/**
 * Slack OAuth2 konfigurasyonu
 */
const SLACK_OAUTH_CONFIG = {
  clientId: process.env.SLACK_CLIENT_ID || '',
  clientSecret: process.env.SLACK_CLIENT_SECRET || '',
  redirectUri: process.env.SLACK_REDIRECT_URI || 'http://localhost:3000/auth/slack/callback',
  authUrl: 'https://slack.com/oauth/v2/authorize',
  tokenUrl: 'https://slack.com/api/oauth.v2.access',
  scope: ['channels:read', 'chat:write', 'groups:read', 'im:read', 'users:read'],
};

/**
 * Slack MCP Server - Diji voice assistant icin
 * Islenen araclar: search_messages, read_channel, send_message, list_channels
 */
export class SlackMCPServer {
  private config: MCPServerConfig;
  private isInitialized: boolean = false;
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
    logger.info('Slack MCP Server baslatiliyor');
    this.isInitialized = true;
    logger.info('Slack MCP Server baslatildi');
  }

  /**
   * Kullanici icin Slack istemcisini hazirlar
   */
  private getSlackClient(userId: string): WebClient | null {
    const token = this.tokenManager.getToken(userId, 'slack');
    if (!token) {
      logger.warn('Slack token bulunamadi', { userId });
      return null;
    }

    if (!this.tokenManager.isTokenValid(token)) {
      logger.warn('Slack token gecersiz veya suresi dolmus', { userId });
      return null;
    }

    return new WebClient(token.access_token);
  }

  /**
   * Tüm MCP araclari ve handler'larini kaydeder
   */
  registerTools(server: Server): void {
    // search_messages - read izni
    registerLegacyTool(server, 
      {
        method: 'tools/call',
        paramsSchema: z.object({
          name: z.literal('search_messages'),
          arguments: z.object({
            query: z.string(),
            channelId: z.string().optional(),
            count: z.number().optional().default(20),
            userId: z.string(),
            sessionId: z.string(),
          }),
        }),
      },
      async (request) => {
        const { query, channelId, count, userId, sessionId } = request.params.arguments as any;

        if (!this.rateLimiter.consume(1)) {
          return {
            success: false,
            error: 'Islem cok fazla. Lutfen biraz bekleyin.',
          };
        }

        const gateResult = this.permissionGate.evaluate(
          { server: 'slack', tool: 'search_messages', arguments: { query, channelId, count }, userId, sessionId },
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

        const slack = this.getSlackClient(userId);
        if (!slack) {
          return {
            success: false,
            error: 'Slack kimlik dogrulama gerekli. Lutfen once OAuth2 ile giris yapin.',
          };
        }

        try {
          const response = await slack.search.messages({
            query,
            count: Math.min(count, 100),
            ...(channelId ? { channel_id: channelId } : {}),
          });

          return {
            success: true,
            data: {
              messages: response.messages?.matches?.map((msg: any) => ({
                id: msg.msg?.ts || '',
                channel: msg.msg?.channel || '',
                text: msg.msg?.text || '',
                user: msg.msg?.user || '',
                timestamp: msg.msg?.ts || '',
              })) || [],
              total: response.messages?.total || 0,
              query,
            },
          };
        } catch (error) {
          logger.error('Slack mesaj arama hatasi', error instanceof Error ? error : undefined);
          return {
            success: false,
            error: 'Mesajlar aranirken hata olustu: ' + (error instanceof Error ? error.message : String(error)),
          };
        }
      }
    );

    // read_channel - read izni
    registerLegacyTool(server, 
      {
        method: 'tools/call',
        paramsSchema: z.object({
          name: z.literal('read_channel'),
          arguments: z.object({
            channelId: z.string(),
            limit: z.number().optional().default(50),
            userId: z.string(),
            sessionId: z.string(),
          }),
        }),
      },
      async (request) => {
        const { channelId, limit, userId, sessionId } = request.params.arguments as any;

        if (!this.rateLimiter.consume(1)) {
          return {
            success: false,
            error: 'Islem cok fazla. Lutfen biraz bekleyin.',
          };
        }

        const gateResult = this.permissionGate.evaluate(
          { server: 'slack', tool: 'read_channel', arguments: { channelId, limit }, userId, sessionId },
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

        const slack = this.getSlackClient(userId);
        if (!slack) {
          return {
            success: false,
            error: 'Slack kimlik dogrulama gerekli.',
          };
        }

        try {
          const response = await slack.conversations.history({
            channel: channelId,
            limit: Math.min(limit, 200),
          });

          return {
            success: true,
            data: {
              channelId,
              messages: response.messages?.map((msg: any) => ({
                id: msg.ts || '',
                text: msg.text || '',
                user: msg.user || '',
                timestamp: msg.ts || '',
                threadTs: msg.thread_ts || '',
              })) || [],
              total: response.messages?.length || 0,
            },
          };
        } catch (error) {
          logger.error('Slack kanal okuma hatasi', error instanceof Error ? error : undefined);
          return {
            success: false,
            error: 'Kanal okunurken hata olustu: ' + (error instanceof Error ? error.message : String(error)),
          };
        }
      }
    );

    // send_message - write izni (onay gerektirir)
    registerLegacyTool(server, 
      {
        method: 'tools/call',
        paramsSchema: z.object({
          name: z.literal('send_message'),
          arguments: z.object({
            channelId: z.string(),
            text: z.string(),
            userId: z.string(),
            sessionId: z.string(),
          }),
        }),
      },
      async (request) => {
        const { channelId, text, userId, sessionId } = request.params.arguments as any;

        if (!this.rateLimiter.consume(1)) {
          return {
            success: false,
            error: 'Islem cok fazla. Lutfen biraz bekleyin.',
          };
        }

        const gateResult = this.permissionGate.evaluate(
          { server: 'slack', tool: 'send_message', arguments: { channelId, text }, userId, sessionId },
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
            message: 'Slack mesaj gonderme onay bekliyor',
            channelId,
            text,
          });
        }

        const slack = this.getSlackClient(userId);
        if (!slack) {
          return {
            success: false,
            error: 'Slack kimlik dogrulama gerekli.',
          };
        }

        try {
          const response = await slack.chat.postMessage({
            channel: channelId,
            text,
          });

          return {
            success: true,
            data: {
              messageId: response.ts || '',
              channelId,
              text,
              message: 'Slack mesaji basariyla gonderildi',
            },
          };
        } catch (error) {
          logger.error('Slack mesaj gonderme hatasi', error instanceof Error ? error : undefined);
          return {
            success: false,
            error: 'Mesaj gonderilirken hata olustu: ' + (error instanceof Error ? error.message : String(error)),
          };
        }
      }
    );

    // list_channels - read izni
    registerLegacyTool(server, 
      {
        method: 'tools/call',
        paramsSchema: z.object({
          name: z.literal('list_channels'),
          arguments: z.object({
            excludeArchived: z.boolean().optional().default(true),
            limit: z.number().optional().default(100),
            userId: z.string(),
            sessionId: z.string(),
          }),
        }),
      },
      async (request) => {
        const { excludeArchived, limit, userId, sessionId } = request.params.arguments as any;

        if (!this.rateLimiter.consume(1)) {
          return {
            success: false,
            error: 'Islem cok fazla. Lutfen biraz bekleyin.',
          };
        }

        const gateResult = this.permissionGate.evaluate(
          { server: 'slack', tool: 'list_channels', arguments: { excludeArchived, limit }, userId, sessionId },
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

        const slack = this.getSlackClient(userId);
        if (!slack) {
          return {
            success: false,
            error: 'Slack kimlik dogrulama gerekli.',
          };
        }

        try {
          const response = await slack.conversations.list({
            exclude_archived: excludeArchived,
            limit: Math.min(limit, 1000),
            types: 'public_channel,private_channel',
          });

          return {
            success: true,
            data: {
              channels: response.channels?.map((ch: any) => ({
                id: ch.id || '',
                name: ch.name || '',
                isPrivate: ch.is_private || false,
                isArchived: ch.is_archived || false,
                created: ch.created || '',
              })) || [],
              total: response.channels?.length || 0,
            },
          };
        } catch (error) {
          logger.error('Slack kanal listeleme hatasi', error instanceof Error ? error : undefined);
          return {
            success: false,
            error: 'Kanallar listelenirken hata olustu: ' + (error instanceof Error ? error.message : String(error)),
          };
        }
      }
    );
  }

  /**
   * OAuth2 yetkilendirme URL'sini dondurur
   */
  getAuthUrl(userId: string): string {
    const state = Buffer.from(userId).toString('base64');
    return `${SLACK_OAUTH_CONFIG.authUrl}?client_id=${SLACK_OAUTH_CONFIG.clientId}&redirect_uri=${encodeURIComponent(SLACK_OAUTH_CONFIG.redirectUri)}&scope=${SLACK_OAUTH_CONFIG.scope.join(',')}&state=${state}`;
  }

  /**
   * OAuth2 callback'i isler ve token'i kaydeder
   */
  async handleOAuthCallback(userId: string, code: string): Promise<any> {
    const response = await fetch(SLACK_OAUTH_CONFIG.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: SLACK_OAUTH_CONFIG.clientId,
        client_secret: SLACK_OAUTH_CONFIG.clientSecret,
        code,
        redirect_uri: SLACK_OAUTH_CONFIG.redirectUri,
      }).toString(),
    });

    const data = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      scope?: string;
      token_type?: string;
      ok?: boolean;
      error?: string;
    };

    if (!data.access_token) {
      throw new Error(`Slack token alinamadi: ${data.error ?? 'bilinmeyen hata'}`);
    }

    const token = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + 3600000,
      scope: data.scope,
      token_type: data.token_type,
    };

    this.tokenManager.saveToken(userId, 'slack', token);
    return token;
  }

  async dispose(): Promise<void> {
    this.isInitialized = false;
    logger.info('Slack MCP Server kapatildi');
  }
}

// --- stdio entrypoint (otomatik eklendi) ---
async function main(): Promise<void> {
  const config = readServerConfigFromEnv('slack');
  const server = new Server(
    { name: 'diji-slack', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  const instance = new SlackMCPServer(config);
  await instance.initialize();
  instance.registerTools(server);

  await runMcpServerStdio(
    server,
    { name: 'diji-slack', version: '1.0.0' },
    () => instance.dispose()
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error('SlackMCPServer baslatilamadi', error);
    process.exit(1);
  });
}

export { main };
