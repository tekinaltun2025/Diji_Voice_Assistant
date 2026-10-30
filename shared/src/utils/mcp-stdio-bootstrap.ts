import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from './logger';

/**
 * Bir MCP sunucusunu stdio tasimasi uzerinden calistirir.
 *
 * Neden gerekli:
 *  - `registerTools()` yalnizca handler kaydi yapar; sunucunun gercekten
 *    dinlemesi icin bir transport'a baglanmasi gerekir.
 *  - Ajan tarafindaki `MCPClient` alt surecleri `node dist/index.js`
 *    seklinde baslatir; bu yuzden her paket calistirilabilir bir giris
 *    noktasina sahip olmalidir.
 *
 * Kullanim:
 * ```ts
 * void runMcpServerStdio('gmail', (server) => {
 *   const instance = new GmailMCPServer(config);
 *   instance.registerTools(server);
 *   return () => instance.dispose();
 * });
 * ```
 */
export interface MCPServerBootstrapInfo {
  name: string;
  version?: string;
}

export async function runMcpServerStdio(
  server: Server,
  info: MCPServerBootstrapInfo,
  onDispose?: () => Promise<void> | void
): Promise<void> {
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info(`${info.name} MCP sunucusu kapatiliyor`, { reason });

    try {
      await server.close();
    } catch (error) {
      logger.warn(`${info.name} MCP sunucusu kapatilirken hata`, {
        error: (error as Error).message,
      });
    }

    if (onDispose) {
      try {
        await onDispose();
      } catch (error) {
        logger.warn(`${info.name} temizlik sirasinda hata`, {
          error: (error as Error).message,
        });
      }
    }

    process.exit(exitCode);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  // stdin kapanirsa (ajan sureci oldu) sunucu da kapanmali; aksi halde
  // yetim surecler birikir.
  process.stdin.on('end', () => {
    void shutdown('stdin-end');
  });
  process.stdin.on('close', () => {
    void shutdown('stdin-close');
  });

  try {
    await server.connect(transport);
    logger.info(`${info.name} MCP sunucusu stdio uzerinde hazir`, {
      version: info.version ?? '1.0.0',
      pid: process.pid,
    });
  } catch (error) {
    logger.error(`${info.name} MCP sunucusu baslatilamadi`, error as Error);
    process.exit(1);
  }
}

/**
 * Yapilandirmayi ortam degiskenlerinden okur ve varsayilanlari doldurur.
 * Alt surec olarak calisirken arguman gecmek pratik olmadigi icin
 * DIJI_MCP_SERVER / DIGI_MCP_* ortam degiskenleri kullanilir.
 */
export function readServerConfigFromEnv(
  name: 'gmail' | 'calendar' | 'drive' | 'notion' | 'slack' | 'chrome'
): {
  name: 'gmail' | 'calendar' | 'drive' | 'notion' | 'slack' | 'chrome';
  enabled: boolean;
  command: string;
  args: string[];
  env: Record<string, string>;
  permissions: { read: boolean; write: boolean; delete: boolean };
  requiresVoiceConfirmation: boolean;
} {
  const deleteAllowed = process.env.DIJI_ALLOW_DELETE === 'true';

  return {
    name,
    enabled: true,
    command: process.execPath,
    args: [],
    env: {},
    permissions: { read: true, write: true, delete: deleteAllowed },
    requiresVoiceConfirmation: true,
  };
}
