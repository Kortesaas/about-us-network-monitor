import type { PlannedDevice } from '@shared/types'
import { normalizeMac, isUnicastMac } from '@shared/mac'
import type { SnmpSession, SnmpVarbind } from '../transport.js'
import type { RawFdbEntry, RawLldpNeighbor, RawSwitch, RawVlan } from '../../state/raw.js'
import { asMac, asNumber, asString, column, portListToPorts, suffix } from './client.js'
import { OID } from './oids.js'
import { mapInterfacesToPorts, parsePortNumber } from './vendor.js'

const RATE_HISTORY = 24

const walkAll = async (session: SnmpSession, oids: string[]) => {
  const out: SnmpVarbind[] = []
  for (const oid of oids) out.push(...(await session.walk(oid)))
  return out
}

/**
 * Interface names/types are needed by every other poll (to know which ifIndex
 * is which port), so they are fetched once and refreshed by the config poll.
 */
async function ensureInterfaceIdentity(session: SnmpSession, raw: RawSwitch, device: PlannedDevice, force = false) {
  if (raw.portMap.size > 0 && !force) return
  const varbinds = await walkAll(session, [OID.ifDescr, OID.ifType, OID.ifName, OID.ifAlias, OID.ifPhysAddress])
  const descr = column(varbinds, OID.ifDescr)
  const type = column(varbinds, OID.ifType)
  const name = column(varbinds, OID.ifName)
  const alias = column(varbinds, OID.ifAlias)
  const phys = column(varbinds, OID.ifPhysAddress)
  for (const key of new Set([...descr.keys(), ...name.keys()])) {
    const ifIndex = Number(key)
    const existing = raw.interfaces.get(ifIndex)
    raw.interfaces.set(ifIndex, {
      ifIndex,
      ifName: asString(name.get(key) ?? null),
      ifDescr: asString(descr.get(key) ?? null),
      ifAlias: asString(alias.get(key) ?? null),
      ifType: asNumber(type.get(key) ?? null),
      physAddress: asMac(phys.get(key) ?? null),
      adminUp: existing?.adminUp ?? null,
      operUp: existing?.operUp ?? null,
      lastChangeTicks: existing?.lastChangeTicks ?? null,
      speedMbps: existing?.speedMbps ?? null,
      counters: existing?.counters ?? null,
    })
  }
  const mapping = mapInterfacesToPorts([...raw.interfaces.values()], device)
  raw.portMap = mapping.map
  raw.portMapNote = mapping.note
}

/** Every 30 s: uptime, link state and counters. Cheap — six columns. */
export async function pollSwitchFast(session: SnmpSession, raw: RawSwitch, device: PlannedDevice) {
  const started = Date.now()
  await ensureInterfaceIdentity(session, raw, device)
  const sys = await session.get([OID.sysUpTime])
  const upTime = asNumber(sys[0]?.value ?? null)
  raw.sys = { ...(raw.sys ?? { descr: null, name: null, location: null, objectId: null }), upTimeTicks: upTime, at: started }

  const varbinds = await walkAll(session, [
    OID.ifAdminStatus,
    OID.ifOperStatus,
    OID.ifLastChange,
    OID.ifHighSpeed,
    OID.ifHCInOctets,
    OID.ifHCOutOctets,
    OID.ifInErrors,
    OID.ifOutErrors,
    OID.ifInDiscards,
    OID.ifOutDiscards,
  ])
  const admin = column(varbinds, OID.ifAdminStatus)
  const oper = column(varbinds, OID.ifOperStatus)
  const change = column(varbinds, OID.ifLastChange)
  const speed = column(varbinds, OID.ifHighSpeed)
  let hcIn = column(varbinds, OID.ifHCInOctets)
  let hcOut = column(varbinds, OID.ifHCOutOctets)
  if (hcIn.size === 0) {
    // Old agents without IF-MIB HC counters: fall back to the 32-bit ones.
    const legacy = await walkAll(session, [OID.ifInOctets, OID.ifOutOctets])
    hcIn = column(legacy, OID.ifInOctets)
    hcOut = column(legacy, OID.ifOutOctets)
  }
  const inErr = column(varbinds, OID.ifInErrors)
  const outErr = column(varbinds, OID.ifOutErrors)
  const inDisc = column(varbinds, OID.ifInDiscards)
  const outDisc = column(varbinds, OID.ifOutDiscards)

  const now = Date.now()
  for (const [ifIndex, iface] of raw.interfaces) {
    const key = String(ifIndex)
    const previous = iface.counters
    iface.adminUp = admin.has(key) ? asNumber(admin.get(key)!) === 1 : iface.adminUp
    iface.operUp = oper.has(key) ? asNumber(oper.get(key)!) === 1 : iface.operUp
    iface.lastChangeTicks = asNumber(change.get(key) ?? null) ?? iface.lastChangeTicks
    iface.speedMbps = asNumber(speed.get(key) ?? null) ?? iface.speedMbps
    const inOctets = toBig(hcIn.get(key))
    const outOctets = toBig(hcOut.get(key))
    if (inOctets === null && outOctets === null) continue
    iface.counters = {
      inOctets: inOctets ?? 0n,
      outOctets: outOctets ?? 0n,
      inErrors: asNumber(inErr.get(key) ?? null) ?? 0,
      outErrors: asNumber(outErr.get(key) ?? null) ?? 0,
      inDiscards: asNumber(inDisc.get(key) ?? null) ?? 0,
      outDiscards: asNumber(outDisc.get(key) ?? null) ?? 0,
      sampledAt: now,
    }
    const port = raw.portMap.get(ifIndex)
    if (port === undefined || !previous) continue
    const seconds = (now - previous.sampledAt) / 1000
    if (seconds < 1) continue
    const delta = (current: bigint, before: bigint) => (current >= before ? Number(current - before) : Number(current))
    const errors =
      Math.max(0, iface.counters.inErrors - previous.inErrors) +
      Math.max(0, iface.counters.outErrors - previous.outErrors) +
      Math.max(0, iface.counters.inDiscards - previous.inDiscards) +
      Math.max(0, iface.counters.outDiscards - previous.outDiscards)
    const history = raw.rateHistory.get(port) ?? []
    history.push({
      t: now,
      inBps: (delta(iface.counters.inOctets, previous.inOctets) * 8) / seconds,
      outBps: (delta(iface.counters.outOctets, previous.outOctets) * 8) / seconds,
      errorsPerMin: (errors / seconds) * 60,
    })
    while (history.length > RATE_HISTORY) history.shift()
    raw.rateHistory.set(port, history)
  }
  raw.lastFastAt = now
  raw.lastOkAt = now
  raw.lastError = null
  raw.lastDurationMs = now - started
}

const toBig = (value: SnmpVarbind['value'] | undefined): bigint | null => {
  if (value === undefined || value === null) return null
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(Math.max(0, Math.floor(value)))
  if (Buffer.isBuffer(value)) return value.length ? BigInt(`0x${value.toString('hex')}`) : null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? BigInt(parsed) : null
}

/** Every 2 min: who is plugged in where (FDB) and what the ports see (LLDP). */
export async function pollSwitchTables(session: SnmpSession, raw: RawSwitch, device: PlannedDevice) {
  const started = Date.now()
  await ensureInterfaceIdentity(session, raw, device)
  if (raw.bridgePortToIfIndex.size === 0) await pollBridgePortMap(session, raw)

  // Q-BRIDGE (VLAN aware) first, plain BRIDGE-MIB as fallback.
  let fdb: RawFdbEntry[] = []
  const qFdb = await session.walk(OID.dot1qTpFdbPort)
  if (qFdb.length > 0) {
    for (const varbind of qFdb) {
      const parts = suffix(varbind.oid, OID.dot1qTpFdbPort)
      if (parts.length < 7) continue
      const mac = macFromOidParts(parts.slice(1, 7))
      const bridgePort = asNumber(varbind.value)
      if (!mac || !bridgePort || !isUnicastMac(mac)) continue
      fdb.push({ mac, vlanId: parts[0]!, bridgePort, seenAt: started })
    }
  } else {
    const dFdb = await session.walk(OID.dot1dTpFdbPort)
    for (const varbind of dFdb) {
      const parts = suffix(varbind.oid, OID.dot1dTpFdbPort)
      const mac = macFromOidParts(parts.slice(0, 6))
      const bridgePort = asNumber(varbind.value)
      if (!mac || !bridgePort || !isUnicastMac(mac)) continue
      fdb.push({ mac, vlanId: null, bridgePort, seenAt: started })
    }
  }
  // Ignore the switch's own MACs and entries on bridge port 0 (CPU / self).
  const own = new Set([...raw.interfaces.values()].map((iface) => iface.physAddress).filter(Boolean))
  fdb = fdb.filter((entry) => entry.bridgePort > 0 && !own.has(entry.mac))
  raw.fdb = fdb

  // LLDP: local port table for naming, then the remote table.
  const local = await walkAll(session, [OID.lldpLocPortId, OID.lldpLocPortDesc])
  const locId = column(local, OID.lldpLocPortId)
  const locDesc = column(local, OID.lldpLocPortDesc)
  raw.lldpLocalPorts = new Map()
  for (const key of new Set([...locId.keys(), ...locDesc.keys()]))
    raw.lldpLocalPorts.set(Number(key), {
      portId: asString(locId.get(key) ?? null) ?? '',
      portDesc: asString(locDesc.get(key) ?? null) ?? '',
    })

  const remote = await walkAll(session, [
    OID.lldpRemChassisIdSubtype,
    OID.lldpRemChassisId,
    OID.lldpRemPortIdSubtype,
    OID.lldpRemPortId,
    OID.lldpRemPortDesc,
    OID.lldpRemSysName,
    OID.lldpRemSysDesc,
  ])
  const chassisSub = column(remote, OID.lldpRemChassisIdSubtype)
  const chassis = column(remote, OID.lldpRemChassisId)
  const portSub = column(remote, OID.lldpRemPortIdSubtype)
  const portId = column(remote, OID.lldpRemPortId)
  const portDesc = column(remote, OID.lldpRemPortDesc)
  const sysName = column(remote, OID.lldpRemSysName)
  const sysDesc = column(remote, OID.lldpRemSysDesc)
  const manAddr = await session.walk(OID.lldpRemManAddrIfSubtype)
  const managementByRow = new Map<string, string>()
  for (const varbind of manAddr) {
    // index: timeMark.localPort.remIndex.addrSubtype.addrLen.addr…
    const parts = suffix(varbind.oid, OID.lldpRemManAddrIfSubtype)
    if (parts.length < 9 || parts[3] !== 1) continue
    const row = parts.slice(0, 3).join('.')
    const length = parts[4]!
    if (length !== 4) continue
    managementByRow.set(row, parts.slice(5, 9).join('.'))
  }
  const neighbors: RawLldpNeighbor[] = []
  for (const key of chassis.keys()) {
    const [, localPortNum] = key.split('.').map(Number)
    if (!localPortNum) continue
    const chassisIdSubtype = asNumber(chassisSub.get(key) ?? null)
    const portIdSubtype = asNumber(portSub.get(key) ?? null)
    neighbors.push({
      localPortNum,
      chassisIdSubtype,
      chassisId: idToString(chassis.get(key) ?? null, chassisIdSubtype),
      portIdSubtype,
      portId: idToString(portId.get(key) ?? null, portIdSubtype),
      portDesc: asString(portDesc.get(key) ?? null) ?? '',
      sysName: asString(sysName.get(key) ?? null) ?? '',
      sysDesc: asString(sysDesc.get(key) ?? null) ?? '',
      managementIp: managementByRow.get(key) ?? null,
    })
  }
  raw.lldp = neighbors
  const now = Date.now()
  raw.lastTablesAt = now
  raw.lastOkAt = now
  raw.lastError = null
  raw.lastDurationMs = now - started
}

/** Every 5 min: identity and VLAN configuration. */
export async function pollSwitchConfig(session: SnmpSession, raw: RawSwitch, device: PlannedDevice) {
  const started = Date.now()
  const sys = await session.get([OID.sysDescr, OID.sysName, OID.sysLocation, OID.sysObjectID, OID.sysUpTime])
  raw.sys = {
    descr: asString(sys[0]?.value ?? null),
    name: asString(sys[1]?.value ?? null),
    location: asString(sys[2]?.value ?? null),
    objectId: asString(sys[3]?.value ?? null),
    upTimeTicks: asNumber(sys[4]?.value ?? null),
    at: started,
  }
  await ensureInterfaceIdentity(session, raw, device, true)
  await pollBridgePortMap(session, raw)

  const names = column(await session.walk(OID.dot1qVlanStaticName), OID.dot1qVlanStaticName)
  let egress = column(await session.walk(OID.dot1qVlanStaticEgressPorts), OID.dot1qVlanStaticEgressPorts)
  let untagged = column(await session.walk(OID.dot1qVlanStaticUntaggedPorts), OID.dot1qVlanStaticUntaggedPorts)
  if (egress.size === 0) {
    // Some agents only fill the "current" table (index timeMark.vlan).
    const strip = (map: Map<string, SnmpVarbind['value']>) =>
      new Map([...map].map(([key, value]) => [key.split('.').pop()!, value]))
    egress = strip(column(await session.walk(OID.dot1qVlanCurrentEgressPorts), OID.dot1qVlanCurrentEgressPorts))
    untagged = strip(column(await session.walk(OID.dot1qVlanCurrentUntaggedPorts), OID.dot1qVlanCurrentUntaggedPorts))
  }
  const vlans: RawVlan[] = []
  for (const key of new Set([...egress.keys(), ...names.keys()])) {
    const vlanId = Number(key)
    if (!Number.isInteger(vlanId) || vlanId < 1) continue
    vlans.push({
      vlanId,
      name: asString(names.get(key) ?? null),
      egressBridgePorts: portListToPorts(egress.get(key) ?? null),
      untaggedBridgePorts: portListToPorts(untagged.get(key) ?? null),
    })
  }
  raw.vlans = vlans.sort((a, b) => a.vlanId - b.vlanId)

  const pvid = column(await session.walk(OID.dot1qPvid), OID.dot1qPvid)
  raw.pvid = new Map()
  for (const [key, value] of pvid) {
    const id = asNumber(value)
    if (id !== null) raw.pvid.set(Number(key), id)
  }
  const now = Date.now()
  raw.lastConfigAt = now
  raw.lastOkAt = now
  raw.lastError = null
  raw.lastDurationMs = now - started
}

async function pollBridgePortMap(session: SnmpSession, raw: RawSwitch) {
  const rows = column(await session.walk(OID.dot1dBasePortIfIndex), OID.dot1dBasePortIfIndex)
  raw.bridgePortToIfIndex = new Map()
  for (const [key, value] of rows) {
    const ifIndex = asNumber(value)
    if (ifIndex !== null) raw.bridgePortToIfIndex.set(Number(key), ifIndex)
  }
}

const macFromOidParts = (parts: number[]) =>
  parts.length === 6 && parts.every((part) => part >= 0 && part <= 255)
    ? parts.map((part) => part.toString(16).padStart(2, '0')).join(':')
    : null

/** LLDP ids are MACs (subtype 4), interface names (5), network addresses (…) or free text. */
function idToString(value: SnmpVarbind['value'] | null, subtype: number | null): string {
  if (value === null) return ''
  if (subtype === 4) return asMac(value) ?? asString(value) ?? ''
  if (Buffer.isBuffer(value)) {
    // Network address: first byte is the family (1 = IPv4).
    if (subtype === 5 && value.length === 5 && value[0] === 1) return [...value.slice(1)].join('.')
    const text = value.toString('utf8')
    if (/^[\x20-\x7e]*$/.test(text)) return text.trim()
    return value.length === 6 ? (asMac(value) ?? value.toString('hex')) : value.toString('hex')
  }
  return String(value)
}

/** Bridge port → physical port number, via ifIndex when the switch maps them, else identity. */
export function bridgePortToPort(raw: RawSwitch, bridgePort: number): number | null {
  const ifIndex = raw.bridgePortToIfIndex.get(bridgePort) ?? bridgePort
  return raw.portMap.get(ifIndex) ?? null
}

/** LLDP local port numbers are usually ifIndex; fall back to the LLDP port id/desc, then to bridge ports. */
export function lldpLocalToPort(raw: RawSwitch, localPortNum: number, device: PlannedDevice): number | null {
  const viaIfIndex = raw.portMap.get(localPortNum)
  if (viaIfIndex !== undefined) return viaIfIndex
  const local = raw.lldpLocalPorts.get(localPortNum)
  if (local) {
    const byName = parsePortNumber(
      { ifIndex: localPortNum, ifName: local.portId || null, ifDescr: local.portDesc || null, ifType: 6 },
      device,
    )
    const total = device.portCount + device.sfpPortCount + device.wanPortCount
    if (byName && byName.port >= 1 && byName.port <= total) return byName.port
  }
  return bridgePortToPort(raw, localPortNum)
}

export const macKey = (mac: string) => normalizeMac(mac) ?? mac
