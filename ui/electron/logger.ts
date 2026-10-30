/**
 * Electron ana süreci için minimal, bağımlılıksız logger.
 * Shared workspace'e bağımlılığı kaldırır; paketleme sırasında
 * modül çözümleme sorunlarını önler.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  [key: string]: unknown;
}

function formatMessage(level: LogLevel, message: string, context?: LogContext): string {
  const timestamp = new Date().toISOString();
  const serialized = context ? ` ${JSON.stringify(context)}` : '';
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${serialized}`;
}

export const logger = {
  debug(message: string, context?: LogContext): void {
    if (process.env.NODE_ENV === 'development') {
      console.debug(formatMessage('debug', message, context));
    }
  },
  info(message: string, context?: LogContext): void {
    console.info(formatMessage('info', message, context));
  },
  warn(message: string, context?: LogContext): void {
    console.warn(formatMessage('warn', message, context));
  },
  error(message: string, context?: LogContext): void {
    console.error(formatMessage('error', message, context));
  },
};
