import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import type { calendar_v3 } from 'googleapis';
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
 * Google Calendar OAuth2 konfigurasyonu
 */
const CALENDAR_OAUTH_CONFIG: OAuth2Config = {
  clientId: process.env.CALENDAR_CLIENT_ID || '',
  clientSecret: process.env.CALENDAR_CLIENT_SECRET || '',
  redirectUri: process.env.CALENDAR_REDIRECT_URI || 'http://localhost:3000/auth/calendar/callback',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scope: [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events',
  ],
};

/**
 * Calendar MCP Server - Diji voice assistant icin
 * Islenen araclar: list_events, create_event, get_event, delete_event
 */
export class CalendarMCPServer {
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
    logger.info('Calendar MCP Server baslatiliyor');

    this.oauth2Client = new google.auth.OAuth2(
      CALENDAR_OAUTH_CONFIG.clientId,
      CALENDAR_OAUTH_CONFIG.clientSecret,
      CALENDAR_OAUTH_CONFIG.redirectUri
    );

    this.isInitialized = true;
    logger.info('Calendar MCP Server baslatildi');
  }

  /**
   * Kullanici icin Calendar API istemcisini hazirlar
   */
  private async getCalendarClient(userId: string): Promise<calendar_v3.Calendar | null> {
    if (!this.oauth2Client) {
      logger.error('OAuth2 istemcisi baslatilmamis');
      return null;
    }

    const token = this.tokenManager.getToken(userId, 'calendar');
    if (!token) {
      logger.warn('Calendar token bulunamadi', { userId });
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
          scope: CALENDAR_OAUTH_CONFIG.scope.join(' '),
        };
        this.tokenManager.saveToken(userId, 'calendar', newToken);
        this.oauth2Client.setCredentials(newToken);
      } catch (error) {
        logger.error('Calendar token yenilenemedi', error instanceof Error ? error : undefined);
        return null;
      }
    } else {
      this.oauth2Client.setCredentials({
        access_token: token.access_token,
        refresh_token: token.refresh_token,
      });
    }

    return google.calendar({ version: 'v3', auth: this.oauth2Client });
  }

  /**
   * Tüm MCP araclari ve handler'larini kaydeder
   */
  registerTools(server: Server): void {
    // list_events - read izni
    registerLegacyTool(server, 
      {
        method: 'tools/call',
        paramsSchema: z.object({
          name: z.literal('list_events'),
          arguments: z.object({
            calendarId: z.string().optional().default('primary'),
            timeMin: z.string().optional(),
            timeMax: z.string().optional(),
            maxResults: z.number().optional().default(10),
            userId: z.string(),
            sessionId: z.string(),
          }),
        }),
      },
      async (request) => {
        const { calendarId, timeMin, timeMax, maxResults, userId, sessionId } = request.params.arguments;

        if (!this.rateLimiter.consume(1)) {
          return {
            success: false,
            error: 'Islem cok fazla. Lutfen biraz bekleyin.',
          };
        }

        const gateResult = this.permissionGate.evaluate(
          { server: 'calendar', tool: 'list_events', arguments: { calendarId, timeMin, timeMax, maxResults }, userId, sessionId },
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

        const calendar = await this.getCalendarClient(userId);
        if (!calendar) {
          return {
            success: false,
            error: 'Calendar kimlik dogrulama gerekli. Lutfen once OAuth2 ile giris yapin.',
          };
        }

        try {
          const response = await calendar.events.list({
            calendarId: calendarId as string,
            timeMin: timeMin as string | undefined,
            timeMax: timeMax as string | undefined,
            maxResults: Math.min(maxResults as number, 50),
            singleEvents: true,
            orderBy: 'startTime',
          });

          const events = response.data.items || [];
          return {
            success: true,
            data: {
              events: events.map((event) => ({
                id: event.id || '',
                summary: event.summary || '',
                description: event.description || '',
                start: event.start?.dateTime || event.start?.date || '',
                end: event.end?.dateTime || event.end?.date || '',
                location: event.location || '',
                attendees: event.attendees?.map((a) => a.email || '') || [],
                status: event.status || '',
                htmlLink: event.htmlLink || '',
              })),
              total: events.length,
            },
          };
        } catch (error) {
          logger.error('Calendar etkinlik listeleme hatasi', error instanceof Error ? error : undefined);
          return {
            success: false,
            error: 'Etkinlikler listelenirken hata olustu: ' + (error instanceof Error ? error.message : String(error)),
          };
        }
      }
    );

    // create_event - write izni (onay gerektirir)
    registerLegacyTool(server, 
      {
        method: 'tools/call',
        paramsSchema: z.object({
          name: z.literal('create_event'),
          arguments: z.object({
            calendarId: z.string().optional().default('primary'),
            summary: z.string(),
            description: z.string().optional().default(''),
            startTime: z.string(),
            endTime: z.string(),
            location: z.string().optional().default(''),
            attendees: z.array(z.string()).optional().default([]),
            userId: z.string(),
            sessionId: z.string(),
          }),
        }),
      },
      async (request) => {
        const { calendarId, summary, description, startTime, endTime, location, attendees, userId, sessionId } = request.params.arguments;

        if (!this.rateLimiter.consume(1)) {
          return {
            success: false,
            error: 'Islem cok fazla. Lutfen biraz bekleyin.',
          };
        }

        const gateResult = this.permissionGate.evaluate(
          { server: 'calendar', tool: 'create_event', arguments: { calendarId, summary, description, startTime, endTime, location, attendees }, userId, sessionId },
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
            message: 'Takvim etkinligi olusturma onay bekliyor',
            summary,
            startTime,
            endTime,
          });
        }

        const calendar = await this.getCalendarClient(userId);
        if (!calendar) {
          return {
            success: false,
            error: 'Calendar kimlik dogrulama gerekli.',
          };
        }

        try {
          const event: calendar_v3.Schema$Event = {
            summary,
            description,
            location,
            start: { dateTime: startTime, timeZone: 'Europe/Istanbul' },
            end: { dateTime: endTime, timeZone: 'Europe/Istanbul' },
            attendees: attendees.map((email: string) => ({ email })),
          };

          const response = await calendar.events.insert({
            calendarId: calendarId as string,
            requestBody: event,
          });

          return {
            success: true,
            data: {
              id: response.data.id || '',
              summary: response.data.summary || '',
              start: response.data.start?.dateTime || response.data.start?.date || '',
              end: response.data.end?.dateTime || response.data.end?.date || '',
              htmlLink: response.data.htmlLink || '',
              message: 'Takvim etkinligi basariyla olusturuldu',
            },
          };
        } catch (error) {
          logger.error('Calendar etkinlik olusturma hatasi', error instanceof Error ? error : undefined);
          return {
            success: false,
            error: 'Etkinlik olusturulurken hata olustu: ' + (error instanceof Error ? error.message : String(error)),
          };
        }
      }
    );

    // get_event - read izni
    registerLegacyTool(server, 
      {
        method: 'tools/call',
        paramsSchema: z.object({
          name: z.literal('get_event'),
          arguments: z.object({
            calendarId: z.string().optional().default('primary'),
            eventId: z.string(),
            userId: z.string(),
            sessionId: z.string(),
          }),
        }),
      },
      async (request) => {
        const { calendarId, eventId, userId, sessionId } = request.params.arguments;

        if (!this.rateLimiter.consume(1)) {
          return {
            success: false,
            error: 'Islem cok fazla. Lutfen biraz bekleyin.',
          };
        }

        const gateResult = this.permissionGate.evaluate(
          { server: 'calendar', tool: 'get_event', arguments: { calendarId, eventId }, userId, sessionId },
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

        const calendar = await this.getCalendarClient(userId);
        if (!calendar) {
          return {
            success: false,
            error: 'Calendar kimlik dogrulama gerekli.',
          };
        }

        try {
          const response = await calendar.events.get({
            calendarId: calendarId as string,
            eventId,
          });

          const event = response.data;
          return {
            success: true,
            data: {
              id: event.id || '',
              summary: event.summary || '',
              description: event.description || '',
              start: event.start?.dateTime || event.start?.date || '',
              end: event.end?.dateTime || event.end?.date || '',
              location: event.location || '',
              attendees: event.attendees?.map((a) => a.email || '') || [],
              status: event.status || '',
              htmlLink: event.htmlLink || '',
            },
          };
        } catch (error) {
          logger.error('Calendar etkinlik getirme hatasi', error instanceof Error ? error : undefined);
          return {
            success: false,
            error: 'Etkinlik alinirken hata olustu: ' + (error instanceof Error ? error.message : String(error)),
          };
        }
      }
    );

    // delete_event - delete izni (her zaman strict voice confirmation)
    registerLegacyTool(server, 
      {
        method: 'tools/call',
        paramsSchema: z.object({
          name: z.literal('delete_event'),
          arguments: z.object({
            calendarId: z.string().optional().default('primary'),
            eventId: z.string(),
            userId: z.string(),
            sessionId: z.string(),
          }),
        }),
      },
      async (request) => {
        const { calendarId, eventId, userId, sessionId } = request.params.arguments;

        if (!this.rateLimiter.consume(1)) {
          return {
            success: false,
            error: 'Islem cok fazla. Lutfen biraz bekleyin.',
          };
        }

        // Delete islemi her zaman strict voice confirmation gerektirir
        const gateResult = this.permissionGate.evaluate(
          { server: 'calendar', tool: 'delete_event', arguments: { calendarId, eventId }, userId, sessionId },
          'delete',
          {
            readEnabled: this.config.permissions.read,
            writeEnabled: this.config.permissions.write,
            deleteEnabled: this.config.permissions.delete,
            requiresVoiceConfirmation: true,
          }
        );

        if (!gateResult.allowed) {
          return permissionGateToResponse(gateResult);
        }

        if (gateResult.requiresConfirmation && gateResult.confirmationToken) {
          return permissionGateToResponse(gateResult, {
            message: 'Takvim etkinligi silme onay bekliyor',
            eventId,
            summary: 'Etkinlik silinecek',
          });
        }

        const calendar = await this.getCalendarClient(userId);
        if (!calendar) {
          return {
            success: false,
            error: 'Calendar kimlik dogrulama gerekli.',
          };
        }

        try {
          await calendar.events.delete({
            calendarId: calendarId as string,
            eventId,
          });

          return {
            success: true,
            data: {
              message: 'Takvim etkinligi basariyla silindi',
              eventId,
            },
          };
        } catch (error) {
          logger.error('Calendar etkinlik silme hatasi', error instanceof Error ? error : undefined);
          return {
            success: false,
            error: 'Etkinlik silinirken hata olustu: ' + (error instanceof Error ? error.message : String(error)),
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
      scope: CALENDAR_OAUTH_CONFIG.scope,
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

    this.tokenManager.saveToken(userId, 'calendar', token);
    return token;
  }

  async dispose(): Promise<void> {
    this.isInitialized = false;
    logger.info('Calendar MCP Server kapatildi');
  }
}

// --- stdio entrypoint (otomatik eklendi) ---
async function main(): Promise<void> {
  const config = readServerConfigFromEnv('calendar');
  const server = new Server(
    { name: 'diji-calendar', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  const instance = new CalendarMCPServer(config);
  await instance.initialize();
  instance.registerTools(server);

  await runMcpServerStdio(
    server,
    { name: 'diji-calendar', version: '1.0.0' },
    () => instance.dispose()
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error('CalendarMCPServer baslatilamadi', error);
    process.exit(1);
  });
}

export { main };
