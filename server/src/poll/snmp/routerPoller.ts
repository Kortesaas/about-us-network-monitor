import { isUnicastMac, normalizeMac } from '@shared/mac'
import type { SnmpSession } from '../transport.js'
import type { RawArp, RawRouterInterface, RawRouterTraffic, RawSysInfo } from '../../state/raw.js'
import { asMac, asNumber, asString, suffix } from './client.js'
import { OID } from './oids.js'

/** System identity + uptime for any SNMP device (router, AP, switch). */
export async function pollSysInfo(session: SnmpSession): Promise<RawSysInfo> {
  const started = Date.now()
  const result = await session.get([OID.sysDescr, OID.sysName, OID.sysUpTime])
  return {
    descr: asString(result[0]?.value ?? null),
    name: asString(result[1]?.value ?? null),
    upTimeTicks: asNumber(result[2]?.value ?? null),
    at: started,
    lastError: null,
    lastOkAt: Date.now(),
    lastDurationMs: Date.now() - started,
  }
}

/**
 * The router's ARP table is the best IP↔MAC source for VLANs the Pi is not
 * directly attached to: every client that talked to its gateway is in there.
 */
export async function pollRouterArp(session: SnmpSession): Promise<RawArp[]> {
  const now = Date.now()
  const rows = await session.walk(OID.ipNetToMediaPhysAddress)
  const entries: RawArp[] = []
  for (const row of rows) {
    const parts = suffix(row.oid, OID.ipNetToMediaPhysAddress)
    if (parts.length < 5) continue
    const ip = parts.slice(1, 5).join('.')
    const mac = asMac(row.value)
    if (!mac || !isUnicastMac(mac)) continue
    entries.push({ ip, mac, source: 'router', reachable: false, at: now })
  }
  return entries
}

/** Interface names that carry the internet uplink on LANCOM/other routers: the logical WAN link, not physical modem or channel entries. */
const WAN_NAME = /^(DSL|VDSL|WAN|PPPOE|INTERNET|WWAN|LTE|MOBILE|UMTS)(-?\d+)?$/i

export function isWanInterfaceName(name: string, explicit: string[]): boolean {
  if (explicit.length) return explicit.some((wanted) => wanted.trim().toLowerCase() === name.trim().toLowerCase())
  return WAN_NAME.test(name.trim())
}

/** Bytes/s between two counter samples; null across wraps/resets. */
export function counterRate(previousAt: number | null, previous: number | null, at: number, current: number | null): number | null {
  if (previousAt === null || previous === null || current === null) return null
  const seconds = (at - previousAt) / 1000
  if (seconds <= 0 || current < previous) return null
  return (current - previous) / seconds
}

/**
 * WAN and physical-port throughput of a router. Names and link state are walked
 * once per discovery interval; every poll only GETs the HC octet counters of the
 * few interfaces that matter (WAN + physical ports that are up).
 */
export async function pollRouterTraffic(
  session: SnmpSession,
  deviceId: string,
  previous: RawRouterTraffic | null,
  options: { explicitWan: string[]; rediscoverAfterMs: number },
): Promise<RawRouterTraffic> {
  const at = Date.now()
  let interfaces: RawRouterInterface[]
  const stale = !previous || at - previous.discoveredAt > options.rediscoverAfterMs || previous.interfaces.length === 0
  let discoveredAt = previous?.discoveredAt ?? at
  let bridgePorts = previous?.bridgePorts ?? new Map<number, number>()
  let names = previous?.names ?? new Map<number, string>()
  if (stale) {
    const [nameRows, oper, bridge] = await Promise.all([session.walk(OID.ifName), session.walk(OID.ifOperStatus), session.walk(OID.dot1dBasePortIfIndex).catch(() => [])])
    const upByIndex = new Map(oper.map((row) => [Number(suffix(row.oid, OID.ifOperStatus)[0]), asNumber(row.value) === 1]))
    names = new Map(nameRows.map((row) => [Number(suffix(row.oid, OID.ifName)[0]), asString(row.value) ?? '']))
    bridgePorts = new Map(bridge.map((row): [number, number] => [Number(suffix(row.oid, OID.dot1dBasePortIfIndex)[0]), asNumber(row.value) ?? 0]).filter(([, ifIndex]) => ifIndex > 0))
    interfaces = nameRows
      .map((row) => ({ ifIndex: Number(suffix(row.oid, OID.ifName)[0]), name: asString(row.value) ?? '' }))
      .filter((item) => Number.isFinite(item.ifIndex) && item.name)
      .map((item) => ({ ...item, operUp: upByIndex.get(item.ifIndex) ?? false, wan: isWanInterfaceName(item.name, options.explicitWan) }))
      // Keep the WAN links plus physical ports; the router has hundreds of tunnel/channel entries nobody needs.
      .filter((item) => item.wan || /^(ETH|LAN|PORT|GE|GI|FE)[-_ ]?\d+$/i.test(item.name))
      .map((item) => {
        const before = previous?.interfaces.find((existing) => existing.ifIndex === item.ifIndex)
        return { ...item, inOctets: before?.inOctets ?? null, outOctets: before?.outOctets ?? null, inBps: null, outBps: null }
      })
    discoveredAt = at
  } else {
    interfaces = previous!.interfaces.map((item) => ({ ...item }))
  }
  const wanted = interfaces.filter((item) => item.wan || item.operUp)
  if (wanted.length) {
    const oids = wanted.flatMap((item) => [`${OID.ifHCInOctets}.${item.ifIndex}`, `${OID.ifHCOutOctets}.${item.ifIndex}`])
    const values = await session.get(oids)
    wanted.forEach((item, index) => {
      const inOctets = asNumber(values[index * 2]?.value ?? null)
      const outOctets = asNumber(values[index * 2 + 1]?.value ?? null)
      const before = previous?.interfaces.find((existing) => existing.ifIndex === item.ifIndex)
      item.inBps = counterRate(previous?.lastOkAt ?? null, before?.inOctets ?? null, at, inOctets)
      item.outBps = counterRate(previous?.lastOkAt ?? null, before?.outOctets ?? null, at, outOctets)
      item.inOctets = inOctets
      item.outOctets = outOctets
    })
  }
  // The bridge MAC table: cheap (a dozen rows) and the only way to say which router LAN port a device hangs on.
  const fdb: RawRouterTraffic['fdb'] = []
  if (bridgePorts.size) {
    const rows = await session.walk(OID.dot1qTpFdbPort).catch(() => [])
    for (const row of rows) {
      const parts = suffix(row.oid, OID.dot1qTpFdbPort)
      if (parts.length < 7) continue
      const mac = normalizeMac(parts.slice(1, 7).map((part) => part.toString(16).padStart(2, '0')).join(':'))
      const bridgePort = asNumber(row.value)
      const ifIndex = bridgePort !== null ? bridgePorts.get(bridgePort) : undefined
      if (!mac || !isUnicastMac(mac) || ifIndex === undefined) continue
      // Prefer the physical port name (ETH-3) over the logical one (LAN-3) when the router lists both.
      const logical = names.get(ifIndex) ?? `port ${bridgePort}`
      const physical = [...names.entries()].find(([, name]) => /^ETH-\d+$/i.test(name) && name.replace(/^ETH-/i, '') === logical.replace(/^LAN-/i, ''))?.[1]
      fdb.push({ mac, vlanId: parts[0] ?? null, ifIndex, portName: physical ?? logical })
    }
  }
  return { deviceId, interfaces, fdb, bridgePorts, names, discoveredAt, at, lastOkAt: at, lastError: null }
}
