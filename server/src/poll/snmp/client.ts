import { createRequire } from 'node:module'
import type { SnmpSession, SnmpSessionOptions, SnmpTransport, SnmpValue, SnmpVarbind } from '../transport.js'

// net-snmp is CommonJS without bundled types; a tiny typed façade keeps the rest of the code clean.
const require = createRequire(import.meta.url)

type RawVarbind = { oid: string; type: number; value: unknown }
type RawSession = {
  get(oids: string[], cb: (error: Error | null, varbinds: RawVarbind[]) => void): void
  subtree(
    oid: string,
    maxRepetitions: number,
    feed: (varbinds: RawVarbind[]) => void,
    done: (error: Error | null) => void,
  ): void
  close(): void
  on(event: 'error', cb: (error: Error) => void): void
}
type NetSnmp = {
  createSession(host: string, community: string, options: Record<string, unknown>): RawSession
  isVarbindError(varbind: RawVarbind): boolean
  varbindError(varbind: RawVarbind): string
  Version1: number
  Version2c: number
  ObjectType: Record<string, number>
}

let netSnmp: NetSnmp | null = null
try {
  netSnmp = require('net-snmp') as NetSnmp
} catch {
  netSnmp = null
}

const OCTET_STRING = 4
const IP_ADDRESS = 64
const COUNTER64 = 70
const OPAQUE = 68

function convert(raw: RawVarbind, snmp: NetSnmp): SnmpValue {
  if (snmp.isVarbindError(raw)) return null
  const { type, value } = raw
  if (value === null || value === undefined) return null
  if (type === COUNTER64 && Buffer.isBuffer(value)) return value.length ? BigInt(`0x${value.toString('hex')}`) : 0n
  if (type === OCTET_STRING || type === OPAQUE) return Buffer.isBuffer(value) ? value : Buffer.from(String(value))
  if (type === IP_ADDRESS) return String(value)
  if (typeof value === 'bigint' || typeof value === 'number') return value
  if (Buffer.isBuffer(value)) return value
  return String(value)
}

class NetSnmpSession implements SnmpSession {
  private readonly session: RawSession
  private closed = false
  constructor(
    private readonly snmp: NetSnmp,
    options: SnmpSessionOptions,
  ) {
    this.session = snmp.createSession(options.host, options.community, {
      port: options.port,
      retries: options.retries,
      timeout: options.timeoutMs,
      version: options.version === '1' ? snmp.Version1 : snmp.Version2c,
      // Keep the socket private to this session; the scheduler bounds concurrency.
      idBitsSize: 32,
    })
    this.session.on('error', () => {
      /* surfaced through the request callbacks */
    })
  }

  get(oids: string[]): Promise<SnmpVarbind[]> {
    return new Promise((resolve, reject) => {
      this.session.get(oids, (error, varbinds) => {
        if (error) return reject(error)
        resolve(varbinds.map((raw) => ({ oid: raw.oid, value: convert(raw, this.snmp) })))
      })
    })
  }

  walk(oid: string): Promise<SnmpVarbind[]> {
    return new Promise((resolve, reject) => {
      const out: SnmpVarbind[] = []
      this.session.subtree(
        oid,
        25,
        (varbinds) => {
          for (const raw of varbinds) {
            const value = convert(raw, this.snmp)
            if (value !== null) out.push({ oid: raw.oid, value })
          }
        },
        (error) => {
          // A NoSuchObject/EndOfMib inside a walk simply means "unsupported" — not a failure.
          if (error && out.length === 0 && /RequestTimedOut|timed out/i.test(error.message)) return reject(error)
          resolve(out)
        },
      )
    })
  }

  close() {
    if (this.closed) return
    this.closed = true
    try {
      this.session.close()
    } catch {
      /* already closed */
    }
  }
}

export class NetSnmpTransport implements SnmpTransport {
  readonly available = netSnmp !== null
  open(options: SnmpSessionOptions): SnmpSession {
    if (!netSnmp) throw new Error('net-snmp is not installed')
    return new NetSnmpSession(netSnmp, options)
  }
}

/* ------------------------------------------------------------- helpers */

export const asString = (value: SnmpValue): string | null => {
  if (value === null) return null
  if (Buffer.isBuffer(value)) return value.toString('utf8').replace(/\0+$/, '').trim()
  return String(value)
}

export const asNumber = (value: SnmpValue): number | null => {
  if (value === null) return null
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (Buffer.isBuffer(value)) return value.length ? Number(value.readUIntBE(0, Math.min(6, value.length))) : null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export const asMac = (value: SnmpValue): string | null => {
  if (Buffer.isBuffer(value) && value.length === 6)
    return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join(':')
  if (typeof value === 'string') {
    const hex = value.replace(/[^0-9a-fA-F]/g, '').toLowerCase()
    if (hex.length === 12) return hex.match(/.{2}/g)!.join(':')
  }
  return null
}

/** The OID suffix after a table column, as numbers: "…1.2.3" → [1,2,3]. */
export const suffix = (oid: string, base: string): number[] =>
  oid
    .slice(base.length + 1)
    .split('.')
    .filter(Boolean)
    .map(Number)

/** PortList bitmap → 1-based bridge port numbers (MSB of the first octet is port 1). */
export function portListToPorts(value: SnmpValue): number[] {
  if (!Buffer.isBuffer(value)) return []
  const ports: number[] = []
  value.forEach((byte, index) => {
    for (let bit = 0; bit < 8; bit += 1) if (byte & (0x80 >> bit)) ports.push(index * 8 + bit + 1)
  })
  return ports
}

/** Groups a walked column by its row index (as a string key). */
export function column(varbinds: SnmpVarbind[], base: string): Map<string, SnmpValue> {
  const out = new Map<string, SnmpValue>()
  for (const varbind of varbinds) {
    if (!varbind.oid.startsWith(`${base}.`)) continue
    out.set(varbind.oid.slice(base.length + 1), varbind.value)
  }
  return out
}
