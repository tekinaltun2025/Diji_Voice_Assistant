import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'crypto';
import { promisify } from 'util';
import { logger } from './logger';
import { OAuth2Token } from '../types/mcp';

const scryptAsync = promisify(scrypt);

/**
 * Şifreli yerel OAuth2 token depolama yöneticisi.
 * Token'lar AES-256-GCM ile şifrelenerek diske kaydedilir.
 */
export class OAuth2TokenManager {
  private storagePath: string;
  private encryptionKey: Buffer;
  private tokens: Map<string, OAuth2Token> = new Map();

  constructor(storageDir: string, password: string) {
    this.storagePath = join(storageDir, 'oauth-tokens.enc');
    this.encryptionKey = this.deriveKey(password);
    this.loadTokens();
  }

  /**
   * Şifre anahtarını türetir (scrypt)
   */
  private async deriveKeyAsync(password: string): Promise<Buffer> {
    const salt = randomBytes(16);
    const key = await scryptAsync(password, salt, 32);
    return key as Buffer;
  }

  private deriveKey(password: string): Buffer {
    // Senkron versiyon: sabit salt ile deterministik anahtar
    const salt = Buffer.from('diji-oauth-salt-v1', 'utf8');
    // scrypt senkron değil, bu yüzden PBKDF2 benzeri basit bir türetim kullanıyoruz
    // Gerçek üretimde crypto.scrypt senkron versiyonu yok, bu yüzden createHash ile türetiyoruz
    const { createHash } = require('crypto');
    return createHash('sha256').update(password + 'diji-oauth-v1').digest();
  }

  /**
   * Token'ları şifreli dosyadan yükler
   */
  private loadTokens(): void {
    try {
      if (!existsSync(this.storagePath)) {
        this.tokens = new Map();
        return;
      }

      const encrypted = readFileSync(this.storagePath);
      const iv = encrypted.subarray(0, 16);
      const authTag = encrypted.subarray(16, 32);
      const ciphertext = encrypted.subarray(32);

      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
      decipher.setAuthTag(authTag);

      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);

      const parsed = JSON.parse(decrypted.toString('utf8'));
      this.tokens = new Map(Object.entries(parsed));
      logger.info('OAuth2 tokenlar yüklendi', { count: this.tokens.size });
    } catch (error) {
      logger.warn('OAuth2 token dosyası okunamadı, yeni başlatılıyor', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.tokens = new Map();
    }
  }

  /**
   * Token'ları şifreli dosyaya kaydeder
   */
  private saveTokens(): void {
    try {
      const dir = join(this.storagePath, '..');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const plaintext = JSON.stringify(Object.fromEntries(this.tokens));
      const iv = randomBytes(16);
      const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);

      const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
      ]);

      const authTag = cipher.getAuthTag();
      const output = Buffer.concat([iv, authTag, encrypted]);
      writeFileSync(this.storagePath, output);
    } catch (error) {
      logger.error('OAuth2 tokenlar kaydedilemedi', error instanceof Error ? { error: error.message, stack: error.stack } : undefined);
    }
  }

  /**
   * Belirli bir kullanıcı ve servis için token'ı alır
   */
  getToken(userId: string, service: string): OAuth2Token | null {
    const key = `${userId}:${service}`;
    return this.tokens.get(key) || null;
  }

  /**
   * Token'ı kaydeder
   */
  saveToken(userId: string, service: string, token: OAuth2Token): void {
    const key = `${userId}:${service}`;
    this.tokens.set(key, token);
    this.saveTokens();
    logger.info('OAuth2 token kaydedildi', { userId, service });
  }

  /**
   * Token'ı siler
   */
  deleteToken(userId: string, service: string): void {
    const key = `${userId}:${service}`;
    this.tokens.delete(key);
    this.saveTokens();
    logger.info('OAuth2 token silindi', { userId, service });
  }

  /**
   * Token'ın geçerli olup olmadığını kontrol eder (süresi dolmamış)
   */
  isTokenValid(token: OAuth2Token): boolean {
    return token.expires_at > Date.now() + 60000; // 1 dakika tolerans
  }

  /**
   * Tüm token'ları temizler
   */
  clearAll(): void {
    this.tokens.clear();
    this.saveTokens();
  }
}