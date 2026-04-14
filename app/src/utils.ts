/**
 * Creates a simple logger that prefixes messages with their level tag.
 * The `debug` method is a no-op unless `logLevel` is set to `'debug'`.
 *
 * @param logLevel - Minimum level to emit. `'debug'` enables all messages;
 *                   `'info'` suppresses debug output. Defaults to `'info'`.
 * @returns An object with `info`, `error`, and `debug` logging methods.
 */
export function createLogger(logLevel: 'debug' | 'info' = 'info') {
  return {
    /**
     * Logs an informational message to stdout.
     * @param args - Values to log, forwarded to `console.log`.
     */
    info: (...args: any[]) => {
      console.log('[INFO]', ...args)
    },

    /**
     * Logs an error message to stderr.
     * @param args - Values to log, forwarded to `console.error`.
     */
    error: (...args: any[]) => {
      console.error('[ERROR]', ...args)
    },

    /**
     * Logs a debug message to stdout. No-op when `logLevel` is `'info'`.
     * @param args - Values to log, forwarded to `console.debug`.
     */
    debug: (...args: any[]) => {
      if (logLevel === 'debug') {
        console.debug('[DEBUG]', ...args)
      }
    },
  }
}
