export function createLogger(logLevel: 'debug' | 'info' = 'info') {
  return {
    info: (...args: any[]) => {
      if (logLevel === 'debug' || logLevel === 'info') {
        console.log('[INFO]', ...args)
      }
    },
    error: (...args: any[]) => {
      console.error('[ERROR]', ...args)
    },
    debug: (...args: any[]) => {
      if (logLevel === 'debug') {
        console.debug('[DEBUG]', ...args)
      }
    },
  }
}
