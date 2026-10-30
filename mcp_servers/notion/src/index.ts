import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@notionhq/client';
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
 * Notion OAuth2 konfigurasyonu
 */
const NOTION_OAUTH_CONFIG = {
  clientId: process.env.NOTION_CLIENT_ID || '',
  clientSecret: process.env.NOTION_CLIENT_SECRET || '',
  redirectUri: process.env.NOTION_REDIRECT_URI || 'http://localhost:3000/auth/notion/callback',
  authUrl: 'https://api.notion.com/v1/oauth/authorize',
  tokenUrl: 'https://api.notion.com/v1/oauth/token',
  scope: ['read', 'write'],
};

/**
 * Notion MCP Server - Diji voice assistant icin
 * Islenen araclar: search_pages, read_page, create_page, update_page
 */
export class NotionMCPServer {
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
    logger.info('Notion MCP Server baslatiliyor');
    this.isInitialized = true;
    logger.info('Notion MCP Server baslatildi');
  }

  /**
   * Kullanici icin Notion istemcisini hazirlar
   */
  private getNotionClient(userId: string): Client | null {
    const token = this.tokenManager.getToken(userId, 'notion');
    if (!token) {
      logger.warn('Notion token bulunamadi', { userId });
      return null;
    }

    if (!this.tokenManager.isTokenValid(token)) {
      logger.warn('Notion token gecersiz veya suresi dolmus', { userId });
      return null;
    }

    return new Client({ auth: token.access_token });
  }

  /**
   * Tüm MCP araclari ve handler'larini kaydeder
   */
  registerTools(server: Server): void {
    // search_pages - read izni
    registerLegacyTool(server, 
      {
        method: 'tools/call',
        paramsSchema: z.object({
          name: z.literal('search_pages'),
          arguments: z.object({
            query: z.string().optional().default(''),
            pageSize: z.number().optional().default(10),
            userId: z.string(),
            sessionId: z.string(),
          }),
        }),
      },
      async (request) => {
        const { query, pageSize, userId, sessionId } = request.params.arguments as any;

        if (!this.rateLimiter.consume(1)) {
          return {
            success: false,
            error: 'Islem cok fazla. Lutfen biraz bekleyin.',
          };
        }

        const gateResult = this.permissionGate.evaluate(
          { server: 'notion', tool: 'search_pages', arguments: { query, pageSize }, userId, sessionId },
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

        const notion = this.getNotionClient(userId);
        if (!notion) {
          return {
            success: false,
            error: 'Notion kimlik dogrulama gerekli. Lutfen once OAuth2 ile giris yapin.',
          };
        }

        try {
          const response = await notion.search({
            query,
            page_size: Math.min(pageSize, 100),
            filter: {
              property: 'object',
              value: 'page',
            },
          });

          return {
            success: true,
            data: {
              pages: response.results.map((page: any) => ({
                id: page.id,
                title: page.properties?.title?.[0]?.plain_text || 'Basliksiz',
                url: page.url,
                createdTime: page.created_time,
                lastEditedTime: page.last_edited_time,
              })),
              total: response.results.length,
              query,
            },
          };
        } catch (error) {
          logger.error('Notion sayfa arama hatasi', error instanceof Error ? error : undefined);
          return {
            success: false,
            error: 'Sayfalar aranirken hata olustu: ' + (error instanceof Error ? error.message : String(error)),
          };
        }
      }
    );

    // read_page - read izni
    registerLegacyTool(server, 
      {
        method: 'tools/call',
        paramsSchema: z.object({
          name: z.literal('read_page'),
          arguments: z.object({
            pageId: z.string(),
            userId: z.string(),
            sessionId: z.string(),
          }),
        }),
      },
      async (request) => {
        const { pageId, userId, sessionId } = request.params.arguments as any;

        if (!this.rateLimiter.consume(1)) {
          return {
            success: false,
            error: 'Islem cok fazla. Lutfen biraz bekleyin.',
          };
        }

        const gateResult = this.permissionGate.evaluate(
          { server: 'notion', tool: 'read_page', arguments: { pageId }, userId, sessionId },
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

        const notion = this.getNotionClient(userId);
        if (!notion) {
          return {
            success: false,
            error: 'Notion kimlik dogrulama gerekli.',
          };
        }

        try {
          const rawPage = await notion.pages.retrieve({ page_id: pageId });
          const blocks = await notion.blocks.children.list({ block_id: pageId });
          // SDK birlestirilmis (union) tip dondurur; alanlar opsiyoneldir.
          const page = rawPage as unknown as {
            id: string;
            url?: string;
            created_time?: string;
            last_edited_time?: string;
            properties?: Record<string, { title?: Array<{ plain_text?: string }> }>;
          };

          return {
            success: true,
            data: {
              id: page.id,
              title: page.properties?.title?.title?.[0]?.plain_text || 'Basliksiz',
              url: page.url,
              createdTime: page.created_time,
              lastEditedTime: page.last_edited_time,
              content: blocks.results.map((block: any) => ({
                id: block.id,
                type: block.type,
                content: block[block.type]?.rich_text?.[0]?.plain_text || '',
              })),
            },
          };
        } catch (error) {
          logger.error('Notion sayfa okuma hatasi', error instanceof Error ? error : undefined);
          return {
            success: false,
            error: 'Sayfa okunurken hata olustu: ' + (error instanceof Error ? error.message : String(error)),
          };
        }
      }
    );

    // create_page - write izni (onay gerektirir)
    registerLegacyTool(server, 
      {
        method: 'tools/call',
        paramsSchema: z.object({
          name: z.literal('create_page'),
          arguments: z.object({
            parentId: z.string(),
            title: z.string(),
            content: z.string().optional().default(''),
            userId: z.string(),
            sessionId: z.string(),
          }),
        }),
      },
      async (request) => {
        const { parentId, title, content, userId, sessionId } = request.params.arguments as any;

        if (!this.rateLimiter.consume(1)) {
          return {
            success: false,
            error: 'Islem cok fazla. Lutfen biraz bekleyin.',
          };
        }

        const gateResult = this.permissionGate.evaluate(
          { server: 'notion', tool: 'create_page', arguments: { parentId, title, content }, userId, sessionId },
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
            message: 'Notion sayfa olusturma onay bekliyor',
            title,
            parentId,
          });
        }

        const notion = this.getNotionClient(userId);
        if (!notion) {
          return {
            success: false,
            error: 'Notion kimlik dogrulama gerekli.',
          };
        }

        try {
          const response = await notion.pages.create({
            parent: { page_id: parentId },
            properties: {
              title: {
                title: [{ text: { content: title } }],
              },
            },
            children: content
              ? [
                  {
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                      rich_text: [{ type: 'text', text: { content } }],
                    },
                  },
                ]
              : [],
          });

          return {
            success: true,
            data: {
              id: response.id,
              title,
              url: (response as unknown as { url?: string }).url,
              message: 'Notion sayfasi basariyla olusturuldu',
            },
          };
        } catch (error) {
          logger.error('Notion sayfa olusturma hatasi', error instanceof Error ? error : undefined);
          return {
            success: false,
            error: 'Sayfa olusturulurken hata olustu: ' + (error instanceof Error ? error.message : String(error)),
          };
        }
      }
    );

    // update_page - write izni (onay gerektirir)
    registerLegacyTool(server, 
      {
        method: 'tools/call',
        paramsSchema: z.object({
          name: z.literal('update_page'),
          arguments: z.object({
            pageId: z.string(),
            title: z.string().optional(),
            content: z.string().optional(),
            userId: z.string(),
            sessionId: z.string(),
          }),
        }),
      },
      async (request) => {
        const { pageId, title, content, userId, sessionId } = request.params.arguments as any;

        if (!this.rateLimiter.consume(1)) {
          return {
            success: false,
            error: 'Islem cok fazla. Lutfen biraz bekleyin.',
          };
        }

        const gateResult = this.permissionGate.evaluate(
          { server: 'notion', tool: 'update_page', arguments: { pageId, title, content }, userId, sessionId },
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
            message: 'Notion sayfa guncelleme onay bekliyor',
            pageId,
            title,
          });
        }

        const notion = this.getNotionClient(userId);
        if (!notion) {
          return {
            success: false,
            error: 'Notion kimlik dogrulama gerekli.',
          };
        }

        try {
          const updateData: any = {};
          if (title) {
            updateData.properties = {
              title: {
                title: [{ text: { content: title } }],
              },
            };
          }

          await notion.pages.update({ page_id: pageId, ...updateData });

          if (content) {
            await notion.blocks.children.append({
              block_id: pageId,
              children: [
                {
                  object: 'block',
                  type: 'paragraph',
                  paragraph: {
                    rich_text: [{ type: 'text', text: { content } }],
                  },
                },
              ],
            });
          }

          return {
            success: true,
            data: {
              id: pageId,
              title: title || '',
              message: 'Notion sayfasi basariyla guncellendi',
            },
          };
        } catch (error) {
          logger.error('Notion sayfa guncelleme hatasi', error instanceof Error ? error : undefined);
          return {
            success: false,
            error: 'Sayfa guncellenirken hata olustu: ' + (error instanceof Error ? error.message : String(error)),
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
    return `${NOTION_OAUTH_CONFIG.authUrl}?client_id=${NOTION_OAUTH_CONFIG.clientId}&redirect_uri=${encodeURIComponent(NOTION_OAUTH_CONFIG.redirectUri)}&response_type=code&state=${state}`;
  }

  /**
   * OAuth2 callback'i isler ve token'i kaydeder
   */
  async handleOAuthCallback(userId: string, code: string): Promise<any> {
    const response = await fetch(NOTION_OAUTH_CONFIG.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from(`${NOTION_OAUTH_CONFIG.clientId}:${NOTION_OAUTH_CONFIG.clientSecret}`).toString('base64'),
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: NOTION_OAUTH_CONFIG.redirectUri,
      }),
    });

    const data = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      scope?: string;
      token_type?: string;
    };
    const token = {
      access_token: data.access_token ?? '',
      refresh_token: data.refresh_token,
      expires_at: Date.now() + 3600000,
      scope: data.scope,
      token_type: data.token_type,
    };

    this.tokenManager.saveToken(userId, 'notion', token);
    return token;
  }

  async dispose(): Promise<void> {
    this.isInitialized = false;
    logger.info('Notion MCP Server kapatildi');
  }
}

// --- stdio entrypoint (otomatik eklendi) ---
async function main(): Promise<void> {
  const config = readServerConfigFromEnv('notion');
  const server = new Server(
    { name: 'diji-notion', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  const instance = new NotionMCPServer(config);
  await instance.initialize();
  instance.registerTools(server);

  await runMcpServerStdio(
    server,
    { name: 'diji-notion', version: '1.0.0' },
    () => instance.dispose()
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error('NotionMCPServer baslatilamadi', error);
    process.exit(1);
  });
}

export { main };
