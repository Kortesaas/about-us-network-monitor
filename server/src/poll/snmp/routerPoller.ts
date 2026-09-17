import { isUnicastMac } from '@shared/mac'
import type { SnmpSession } from '../transport.js'
import type { RawArp, RawSysInfo } from '../../state/raw.js'
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
