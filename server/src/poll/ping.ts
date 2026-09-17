import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { PingResult, PingTransport } from './transport.js'
import { log } from '../logger.js'

const run = promisify(execFile)
const logger = log('ping')

export async function which(tool: string): Promise<boolean> {
  try {
    await run(process.platform === 'win32' ? 'where' : 'which', [tool])
    return true
  } catch {
    return false
  }
}

/**
 * fping does the whole batch in one process with proper pacing — far cheaper
 * than one `ping` per host. `-i 10` spaces packets 10 ms apart so a /24 sweep
 * never bursts, `-r 1` retries once, `-t` is the per-packet timeout.
 */
class FpingTransport implements PingTransport {
  readonly tool = 'fping' as const
  async ping(ips: string[], options: { timeoutMs?: number } = {}): Promise<PingResult[]> {
    if (ips.length === 0) return []
    const timeout = String(options.timeoutMs ?? 800)
    const results = new Map<string, PingResult>(ips.map((ip) => [ip, { ip, alive: false, rttMs: null }]))
    try {
      // fping exits 1 when any host is unreachable, so the failure path is the normal path.
      const { stdout } = await run('fping', ['-e', '-q', '-r', '1', '-i', '10', '-t', timeout, ...ips], {
        maxBuffer: 4 * 1024 * 1024,
        timeout: 60_000,
      })
      parseFping(stdout, results)
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number | string }
      if (typeof failure.stdout === 'string' || typeof failure.stderr === 'string') {
        parseFping(`${failure.stdout ?? ''}\n${failure.stderr ?? ''}`, results)
      } else {
        logger.warn('fping failed', error)
      }
    }
    return [...results.values()]
  }
}

function parseFping(output: string, results: Map<string, PingResult>) {
  // "192.168.99.1 is alive (0.42 ms)" / "192.168.99.5 is unreachable"
  for (const line of output.split('\n')) {
    const match = line.match(/^(\d+\.\d+\.\d+\.\d+)\s+is alive(?:\s+\(([\d.]+) ms\))?/)
    if (!match) continue
    const entry = results.get(match[1]!)
    if (entry) {
      entry.alive = true
      entry.rttMs = match[2] ? Number(match[2]) : null
    }
  }
}

/** Fallback: the system `ping`, one process per host, bounded concurrency. */
class SystemPingTransport implements PingTransport {
  readonly tool = 'ping' as const
  async ping(ips: string[], options: { timeoutMs?: number; concurrency?: number } = {}): Promise<PingResult[]> {
    const timeoutMs = options.timeoutMs ?? 800
    const concurrency = options.concurrency ?? 16
    const results: PingResult[] = []
    let index = 0
    const worker = async () => {
      while (index < ips.length) {
        const ip = ips[index]!
        index += 1
        results.push(await pingOne(ip, timeoutMs))
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, ips.length) }, worker))
    return results
  }
}

async function pingOne(ip: string, timeoutMs: number): Promise<PingResult> {
  const args =
    process.platform === 'darwin'
      ? ['-c', '1', '-W', String(timeoutMs), '-n', ip]
      : ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), '-n', ip]
  try {
    const { stdout } = await run('ping', args, { timeout: timeoutMs + 1500 })
    const rtt = stdout.match(/time[=<]([\d.]+)\s*ms/)
    return { ip, alive: /1 (packets )?received|1 received/.test(stdout) || Boolean(rtt), rttMs: rtt ? Number(rtt[1]) : null }
  } catch {
    return { ip, alive: false, rttMs: null }
  }
}

class NoPingTransport implements PingTransport {
  readonly tool = 'none' as const
  async ping(ips: string[]): Promise<PingResult[]> {
    return ips.map((ip) => ({ ip, alive: false, rttMs: null }))
  }
}

export async function createPingTransport(): Promise<PingTransport> {
  if (await which('fping')) return new FpingTransport()
  if (await which('ping')) {
    logger.warn('fping not found — falling back to the system ping (slower sweeps). Install it with: sudo apt install fping')
    return new SystemPingTransport()
  }
  logger.error('neither fping nor ping found; reachability checks are disabled')
  return new NoPingTransport()
}
