import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Process-level configuration comes from the environment; everything a user
 * would change at runtime lives in `data/settings.json` (see settings.ts).
 */
const here = dirname(fileURLToPath(import.meta.url))
// `server/src/config.ts` under tsx and `server/dist/index.js` when bundled both sit two levels below the root.
export const repoRoot = resolve(here, '../..')

const readVersion = () => {
  try {
    return (JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as { version?: string })
      .version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export const config = {
  mode: (process.env.MONITOR_MODE === 'demo' ? 'demo' : 'live') as 'live' | 'demo',
  port: Number(process.env.PORT ?? 80),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir: resolve(process.env.DATA_DIR ?? resolve(repoRoot, 'data')),
  inventoryFile: resolve(process.env.INVENTORY_FILE ?? resolve(repoRoot, 'config/inventory.json')),
  webDist: resolve(process.env.WEB_DIST ?? resolve(repoRoot, 'web/dist')),
  logLevel: (process.env.LOG_LEVEL ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
  version: readVersion(),
  hostname: hostname(),
}
