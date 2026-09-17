import { execFile } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import { promisify } from 'node:util'
import { normalizeMac } from '@shared/mac'
import type { NeighborEntry, NeighborSource } from './transport.js'
import { which } from './ping.js'

const run = promisify(execFile)

/** Linux `ip neigh`: "192.168.99.1 dev eth0 lladdr 00:a0:57:aa:bb:cc REACHABLE" */
export function parseIpNeigh(output: string): NeighborEntry[] {
  const entries: NeighborEntry[] = []
  for (const line of output.split('\n')) {
    const match = line.match(/^(\d+\.\d+\.\d+\.\d+)\s+dev\s+(\S+)\s+lladdr\s+(\S+)\s+.*?(REACHABLE|STALE|DELAY|PROBE|PERMANENT|FAILED|INCOMPLETE|NOARP)?\s*$/)
    if (!match) continue
    const mac = normalizeMac(match[3])
    if (!mac) continue
    const state = match[4]
    entries.push({
      ip: match[1]!,
      mac,
      interface: match[2]!,
      state: state === 'REACHABLE' || state === 'PERMANENT' ? 'reachable' : state === 'STALE' || state === 'DELAY' || state === 'PROBE' ? 'stale' : 'other',
    })
  }
  return entries
}

/** macOS/BSD `arp -an`: "? (192.168.1.1) at 0:11:22:33:44:55 on en0 ifscope [ethernet]" */
export function parseArpAn(output: string): NeighborEntry[] {
  const entries: NeighborEntry[] = []
  for (const line of output.split('\n')) {
    const match = line.match(/\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-f:]+) on (\S+)/i)
    if (!match) continue
    // BSD prints single-digit octets ("0:11:22"), pad them before normalising.
    const padded = match[2]!.split(':').map((part) => part.padStart(2, '0')).join(':')
    const mac = normalizeMac(padded)
    if (!mac) continue
    entries.push({ ip: match[1]!, mac, interface: match[3]!, state: 'stale' })
  }
  return entries
}

class IpNeighSource implements NeighborSource {
  readonly available = true
  async read() {
    const { stdout } = await run('ip', ['-4', 'neigh', 'show'], { timeout: 5000 })
    return parseIpNeigh(stdout)
  }
}

class ArpSource implements NeighborSource {
  readonly available = true
  async read() {
    const { stdout } = await run('arp', ['-an'], { timeout: 5000 })
    return parseArpAn(stdout)
  }
}

class NoNeighborSource implements NeighborSource {
  readonly available = false
  async read() {
    return []
  }
}

export async function createNeighborSource(): Promise<NeighborSource> {
  if (await which('ip')) return new IpNeighSource()
  if (await which('arp')) return new ArpSource()
  return new NoNeighborSource()
}

/** IPv4 interfaces of this host, with their CIDR, so sweeps know which subnets are on-link. */
export function localInterfaces(): { name: string; ip: string; cidr: string }[] {
  const out: { name: string; ip: string; cidr: string }[] = []
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      out.push({ name, ip: address.address, cidr: address.cidr ?? `${address.address}/32` })
    }
  }
  return out
}
