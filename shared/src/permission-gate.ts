import { randomBytes } from 'crypto';
import { logger } from './utils/logger';
import { MCPCallRequest, MCPCallResponse, MCPPermission, MCPConfirmationStatus } from './types/mcp';

/**
 * Izin seviyeleri:
 * - read: Hemen yurutulur
 * - write: Ses onayi gerektirir (pending_confirmation)
 * - delete: Engellenir (takvim silme haric, her seferinde strict voice confirmation)
 */
export type PermissionGateResult =
  | { allowed: true; requiresConfirmation: false }
  | { allowed: true; requiresConfirmation: true; confirmationToken: string }
  | { allowed: false; reason: string };

/**
 * Permission Gate Middleware
 * MCP cagrilari'nin izin seviyesine gore filtrelenmesini saglar.
 */
export class PermissionGate {
  private confirmationTokens: Map<string, { request: MCPCallRequest; expiresAt: number }> = new Map();
  private readonly TOKEN_TTL_MS = 5 * 60 * 1000; // 5 dakika

  /**
   * Bir MCP cagrisinin izin durumunu degerlendirir
   */
  evaluate(request: MCPCallRequest, permission: MCPPermission, config: {
    readEnabled: boolean;
    writeEnabled: boolean;
    deleteEnabled: boolean;
    requiresVoiceConfirmation: boolean;
  }): PermissionGateResult {
    // read/search: execute immediately
    if (permission === 'read') {
      if (!config.readEnabled) {
        return { allowed: false, reason: 'Read islemleri devre birakilmistir' };
      }
      return { allowed: true, requiresConfirmation: false };
    }

    // write/modify: require voice confirmation
    if (permission === 'write') {
      if (!config.writeEnabled) {
        return { allowed: false, reason: 'Yazma islemleri devre birakilmistir' };
      }
      if (config.requiresVoiceConfirmation) {
        const token = this.generateConfirmationToken(request);
        return {
          allowed: true,
          requiresConfirmation: true,
          confirmationToken: token,
        };
      }
      return { allowed: true, requiresConfirmation: false };
    }

    // delete: blocked (except calendar delete with strict voice confirmation each time)
    if (permission === 'delete') {
      if (!config.deleteEnabled) {
        // Takvim silme islemi her zaman strict voice confirmation gerektirir
        if (request.server === 'calendar') {
          const token = this.generateConfirmationToken(request);
          return {
            allowed: true,
            requiresConfirmation: true,
            confirmationToken: token,
          };
        }
        return { allowed: false, reason: 'Silme islemleri engellenmistir' };
      }
      // Delete enabled ama yine de confirmation gerekli
      const token = this.generateConfirmationToken(request);
      return {
        allowed: true,
        requiresConfirmation: true,
        confirmationToken: token,
      };
    }

    return { allowed: false, reason: 'Bilinmeyen izin turu' };
  }

  /**
   * Onay token'ini dogrular ve ilgili istegi dondurur
   */
  confirm(token: string): { confirmed: boolean; request?: MCPCallRequest; reason?: string } {
    const entry = this.confirmationTokens.get(token);
    if (!entry) {
      return { confirmed: false, reason: 'Gecersiz onay tokeni' };
    }

    if (Date.now() > entry.expiresAt) {
      this.confirmationTokens.delete(token);
      return { confirmed: false, reason: 'Onay tokeni suresi dolmustur' };
    }

    this.confirmationTokens.delete(token);
    return { confirmed: true, request: entry.request };
  }

  /**
   * Onay token'ini olusturur ve saklar
   */
  private generateConfirmationToken(request: MCPCallRequest): string {
    const token = randomBytes(32).toString('hex');
    this.confirmationTokens.set(token, {
      request,
      expiresAt: Date.now() + this.TOKEN_TTL_MS,
    });
    logger.info('Onay tokeni olusturuldu', { tool: request.tool, server: request.server });
    return token;
  }

  /**
   * Bekleyen onaylari temizler (suresi dolmuslari)
   */
  cleanupExpired(): void {
    const now = Date.now();
    for (const [token, entry] of this.confirmationTokens.entries()) {
      if (now > entry.expiresAt) {
        this.confirmationTokens.delete(token);
      }
    }
  }
}

/**
 * Permission gate sonucunu MCPCallResponse'a donusturur
 */
export function permissionGateToResponse(
  result: PermissionGateResult,
  fallbackData?: unknown
): MCPCallResponse {
  if (!result.allowed) {
    return {
      success: false,
      error: result.reason || 'Izın reddedildi',
    };
  }

  if (result.requiresConfirmation && result.confirmationToken) {
    return {
      success: true,
      data: fallbackData,
      requiresConfirmation: true,
      confirmationStatus: 'pending',
      confirmationToken: result.confirmationToken,
    };
  }

  return {
    success: true,
    data: fallbackData,
  };
}