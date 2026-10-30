/**
 * Diji ortak logger.
 *
 * ONEMLI: Tum cikti STDERR'e yazilir. MCP sunuculari stdio tasimasi
 * uzerinden JSON-RPC konusur ve STDOUT tamamen protokole aittir; buraya
 * yazilan tek bir karakter bile protokolu bozar. Bu yuzden `console.log`
 * kullanilmaz.
 */

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const COLORS = {
  error: '\x1b[31m',
  warn: '\x1b[33m',
  info: '\x1b[32m',
  debug: '\x1b[36m',
  reset: '\x1b[0m',
};

const USE_COLOR = process.stderr.isTTY === true;
const color = (name: keyof typeof COLORS): string => (USE_COLOR ? COLORS[name] : '');

function getLevel(): number {
  return LEVELS[LOG_LEVEL as keyof typeof LEVELS] ?? LEVELS.info;
}

/**
 * Serilestirilemeyen degerleri (Error, BigInt, dongulu nesneler) guvenli
 * bicimde log meta'sina cevirir.
 */
function normalizeMeta(meta?: unknown): Record<string, unknown> | undefined {
  if (meta === undefined || meta === null) return undefined;
  if (meta instanceof Error) {
    return { error: meta.message, name: meta.name, stack: meta.stack };
  }
  if (typeof meta === 'object') {
    try {
      // JSON.stringify ile dongulu referanslari test et
      JSON.stringify(meta);
      return meta as Record<string, unknown>;
    } catch {
      return { value: String(meta) };
    }
  }
  return { value: String(meta) };
}

function formatLog(level: string, message: string, meta?: unknown): string {
  const timestamp = new Date().toISOString();
  const normalized = normalizeMeta(meta);
  const metaStr = normalized ? ` ${JSON.stringify(normalized)}` : '';
  return `${timestamp} [${level.toUpperCase()}]: ${message}${metaStr}`;
}

function write(level: keyof typeof LEVELS, message: string, meta?: unknown): void {
  if (LEVELS[level] > getLevel()) return;
  const formatted = formatLog(level, message, meta);
  // Her durumda stderr: stdout MCP protokolune ayrilmistir.
  process.stderr.write(`${color(level)}${formatted}${color('reset')}\n`);
}

export const logger = {
  info: (message: string, meta?: unknown) => write('info', message, meta),
  error: (message: string, meta?: unknown) => write('error', message, meta),
  warn: (message: string, meta?: unknown) => write('warn', message, meta),
  debug: (message: string, meta?: unknown) => write('debug', message, meta),
};

export const logInfo = (message: string, meta?: unknown): void => {
  logger.info(message, meta);
};

export const logError = (
  message: string,
  error?: Error,
  meta?: Record<string, unknown>
): void => {
  logger.error(message, { error: error?.message, stack: error?.stack, ...meta });
};

export const logWarn = (message: string, meta?: unknown): void => {
  logger.warn(message, meta);
};

export const logDebug = (message: string, meta?: unknown): void => {
  logger.debug(message, meta);
};
