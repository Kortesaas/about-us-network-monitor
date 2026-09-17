import { config } from './config.js'

const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const
type Level = keyof typeof levels

const threshold = levels[config.logLevel] ?? levels.info

function write(level: Level, scope: string, message: string, extra?: unknown) {
  if (levels[level] < threshold) return
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout
  if (extra instanceof Error) out.write(`${line} — ${extra.message}\n`)
  else if (extra !== undefined) out.write(`${line} ${JSON.stringify(extra)}\n`)
  else out.write(`${line}\n`)
}

/** journald-friendly line logger: one line per entry, level first. */
export const log = (scope: string) => ({
  debug: (message: string, extra?: unknown) => write('debug', scope, message, extra),
  info: (message: string, extra?: unknown) => write('info', scope, message, extra),
  warn: (message: string, extra?: unknown) => write('warn', scope, message, extra),
  error: (message: string, extra?: unknown) => write('error', scope, message, extra),
})
