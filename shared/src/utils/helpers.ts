import { createHash, randomBytes } from 'crypto';

/**
 * String değerini SHA-256 ile hashler
 */
export const hashString = (input: string): string => {
  return createHash('sha256').update(input).digest('hex');
};

/**
 * Belirtilen uzunlukta rastgele bir string üretir
 */
export const generateRandomString = (length: number = 32): string => {
  return randomBytes(length).toString('hex');
};

/**
 * Nesneyi derin kopyalar (deep clone)
 */
export const deepClone = <T>(value: T): T => {
  return JSON.parse(JSON.stringify(value));
};

/**
 * Belirtilen milisaniye kadar bekler (sleep)
 */
export const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * Rate limiting için basit bir token bucket implementasyonu
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private maxTokens: number,
    private refillRatePerSecond: number
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  /**
   * İzin veriyorsa true döner, aksi halde false
   */
  consume(tokens: number = 1): boolean {
    this.refill();
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    return false;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const refillAmount = elapsed * this.refillRatePerSecond;
    this.tokens = Math.min(this.maxTokens, this.tokens + refillAmount);
    this.lastRefill = now;
  }

  /**
   * Bir token'ın yeniden doldurulması için gereken milisaniye süresi
   */
  timeUntilAvailable(tokens: number = 1): number {
    this.refill();
    if (this.tokens >= tokens) return 0;
    const needed = tokens - this.tokens;
    return Math.ceil((needed / this.refillRatePerSecond) * 1000);
  }
}