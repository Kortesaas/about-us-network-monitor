import type {
  DiscoveredPortConfig,
  LldpNeighbor,
  PlannedDevice,
  PlannedPort,
  PortDiff,
  Reachability,
  SnmpHealth,
  SwitchPort,
  SwitchState,
} from '@shared/types'
import type { Store } from '../state/store.js'
import type { RawSwitch } from '../state/raw.js'
import { bridgePortToPort, lldpLocalToPort } from '../poll/snmp/switchPoller.js'
import { totalPorts } from '../inventory/plan.js'

export function reachabilityFor(store: Store, ip: string | null, now: number): { reachability: Reachability; rttMs: number | null; lastSeenAt: number | null } {
  if (!ip) return { reachability: 'unknown', rttMs: null, lastSeenAt: null }
  const ping = store.pings.get(ip)
  if (!ping) return { reachability: 'unknown', rttMs: null, lastSeenAt: null }
  if (ping.alive) return { reachability: 'online', rttMs: ping.rttMs, lastSeenAt: ping.lastAliveAt }
  if (ping.lastAliveAt === null) return { reachability: 'offline', rttMs: null, lastSeenAt: null }
  const age = now - ping.lastAliveAt
  // Infra is pinged every few seconds: one or two misses are "stale", repeated misses are "offline".
  const staleWindow = Math.max(90_000, store.settings.polling.infraPingSeconds * 4 * 1000)
  if (age <= staleWindow) return { reachability: 'stale', rttMs: null, lastSeenAt: ping.lastAliveAt }
  return { reachability: 'offline', rttMs: null, lastSeenAt: ping.lastAliveAt }
}

export function snmpHealth(raw: { lastOkAt: number | null; lastError: string | null; lastDurationMs: number | null } | null, enabled: boolean, now: number, maxAgeMs: number): SnmpHealth {
  if (!raw) return { enabled, ok: false, lastOkAt: null, lastError: enabled ? null : 'SNMP disabled', lastDurationMs: null }
  const fresh = raw.lastOkAt !== null && now - raw.lastOkAt <= maxAgeMs
  return {
    enabled,
    ok: enabled && fresh && !raw.lastError,
    lastOkAt: raw.lastOkAt ? new Date(raw.lastOkAt).toISOString() : null,
    lastError: raw.lastError,
    lastDurationMs: raw.lastDurationMs,
  }
}

/** Is this planned trunk the special AP flavour (management untagged, client VLANs tagged, no 99 tag)? */
export const isApTrunk = (port: PlannedPort | null) =>
  Boolean(port && port.mode === 'trunk' && /\bap\b/i.test(port.name) && !port.taggedVlanIds.includes(99))

const EMPTY_LLDP: LldpNeighbor[] = []

export function buildSwitches(store: Store, now: number): SwitchState[] {
  const planned = store.inventory.devices.filter((device) => device.type === 'switch')
  const { thresholds, polling } = store.settings
  return planned.map((device) => buildSwitch(store, device, store.rawSwitch(device.id), now, thresholds.uplinkMacThreshold, polling.snmpFastSeconds))
}

function buildSwitch(store: Store, device: PlannedDevice, raw: RawSwitch, now: number, uplinkThreshold: number, fastSeconds: number): SwitchState {
  const reach = reachabilityFor(store, device.managementIp, now)
  const target = store.settings.snmp.targets.find((item) => item.deviceId === device.id)
  const snmpEnabled = target ? target.enabled : true
  const health = snmpHealth(raw, snmpEnabled, now, Math.max(fastSeconds * 3, 120) * 1000)
  const total = totalPorts(device)
  const inventoryById = new Map(store.inventory.devices.map((item) => [item.id, item]))
  const inventoryByIp = new Map(store.inventory.devices.filter((item) => item.managementIp).map((item) => [item.managementIp, item]))
  const inventoryByName = new Map(store.inventory.devices.map((item) => [item.name.toLowerCase(), item]))
  const switchMacs = new Map<string, string>()
  for (const other of store.switches.values())
    for (const iface of other.interfaces.values()) if (iface.physAddress) switchMacs.set(iface.physAddress, other.deviceId)
  // Planned devices that are not polled (not in the setup, no SNMP) are still known by MAC through ARP on
  // their management IP — that is how a disabled switch's LLDP chassis id is recognised as that device.
  for (const entry of store.arp.values()) {
    const planned = inventoryByIp.get(entry.ip)
    if (planned && !switchMacs.has(entry.mac)) switchMacs.set(entry.mac, planned.id)
  }

  // ifIndex per port.
  const ifIndexForPort = new Map<number, number>()
  for (const [ifIndex, port] of raw.portMap) ifIndexForPort.set(port, ifIndex)
  const bridgePortForPort = new Map<number, number>()
  const bridgePorts = raw.bridgePortToIfIndex.size ? [...raw.bridgePortToIfIndex.keys()] : [...raw.portMap.keys()]
  for (const bridgePort of bridgePorts) {
    const port = bridgePortToPort(raw, bridgePort)
    if (port !== null) bridgePortForPort.set(port, bridgePort)
  }

  // FDB grouped by port.
  const macsByPort = new Map<number, SwitchPort['macs']>()
  for (const entry of raw.fdb) {
    const port = bridgePortToPort(raw, entry.bridgePort)
    if (port === null) continue
    const list = macsByPort.get(port) ?? []
    list.push({ mac: entry.mac, vlanId: entry.vlanId, deviceId: null, lastSeenAt: new Date(entry.seenAt).toISOString() })
    macsByPort.set(port, list)
  }
  // LLDP grouped by port, matched against the inventory.
  const lldpByPort = new Map<number, LldpNeighbor[]>()
  for (const neighbor of raw.lldp) {
    const port = lldpLocalToPort(raw, neighbor.localPortNum, device)
    if (port === null) continue
    let matched: PlannedDevice | undefined
    if (neighbor.managementIp) matched = inventoryByIp.get(neighbor.managementIp)
    if (!matched && neighbor.chassisIdSubtype === 4) {
      const id = switchMacs.get(neighbor.chassisId)
      if (id) matched = inventoryById.get(id)
    }
    if (!matched && neighbor.sysName) matched = inventoryByName.get(neighbor.sysName.toLowerCase())
    if (!matched && neighbor.sysName) {
      // Router / switch sysNames are often set to the planned name or the hostname.
      for (const other of store.sysInfo) if (other[1].name && other[1].name.toLowerCase() === neighbor.sysName.toLowerCase()) matched = inventoryById.get(other[0])
      for (const [id, other] of store.switches) if (other.sys?.name && other.sys.name.toLowerCase() === neighbor.sysName.toLowerCase()) matched = inventoryById.get(id)
    }
    const list = lldpByPort.get(port) ?? []
    list.push({
      chassisId: neighbor.chassisId,
      portId: neighbor.portId,
      portDescription: neighbor.portDesc,
      sysName: neighbor.sysName,
      sysDescription: neighbor.sysDesc,
      managementIp: neighbor.managementIp,
      deviceId: matched?.id ?? null,
    })
    lldpByPort.set(port, list)
  }

  const ports: SwitchPort[] = []
  for (let number = 1; number <= total; number += 1) {
    const plannedPort = device.ports.find((item) => item.number === number) ?? null
    const ifIndex = ifIndexForPort.get(number) ?? null
    const iface = ifIndex !== null ? raw.interfaces.get(ifIndex) : undefined
    const bridgePort = bridgePortForPort.get(number) ?? null
    const discovered = discoveredConfig(raw, bridgePort)
    const lldp = lldpByPort.get(number) ?? EMPTY_LLDP
    const macs = (macsByPort.get(number) ?? []).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
    const neighborIsInfra = lldp.some((item) => {
      const dev = item.deviceId ? inventoryById.get(item.deviceId) : null
      return dev ? dev.type === 'switch' || dev.type === 'router' : /switch|router|bridge/i.test(item.sysDescription)
    })
    // A port faces other infrastructure when LLDP says so, or when it has learned too many MACs to be a
    // single device. A planned trunk with a handful of MACs (the Pi on its trunk port) is still an edge port.
    const macCount = new Set(macs.map((item) => item.mac)).size
    const plannedTrunk = (plannedPort?.mode === 'trunk' || plannedPort?.mode === 'hybrid') && !isApTrunk(plannedPort)
    const uplink = neighborIsInfra || macCount > uplinkThreshold || (plannedTrunk && macCount >= 3) || (discovered?.mode === 'trunk' && !plannedPort && macCount >= 3)
    const rates = raw.rateHistory.get(number)
    const latest = rates?.[rates.length - 1]
    const sysUptime = raw.sys?.upTimeTicks ?? null
    ports.push({
      number,
      ifIndex,
      ifName: iface?.ifName ?? iface?.ifDescr ?? null,
      ifAlias: iface?.ifAlias || null,
      role: plannedPort?.role ?? (number > device.portCount + device.wanPortCount ? 'sfp' : 'lan'),
      planned: plannedPort,
      link: iface && iface.operUp !== null
        ? {
            operUp: iface.operUp === true,
            adminUp: iface.adminUp !== false,
            speedMbps: iface.operUp ? iface.speedMbps : null,
            lastChangeAt:
              iface.lastChangeTicks !== null && sysUptime !== null && raw.sys
                ? new Date(raw.sys.at - (sysUptime - iface.lastChangeTicks) * 10).toISOString()
                : null,
          }
        : null,
      counters: iface?.counters
        ? {
            inOctets: Number(iface.counters.inOctets),
            outOctets: Number(iface.counters.outOctets),
            inErrors: iface.counters.inErrors,
            outErrors: iface.counters.outErrors,
            inDiscards: iface.counters.inDiscards,
            outDiscards: iface.counters.outDiscards,
            sampledAt: new Date(iface.counters.sampledAt).toISOString(),
          }
        : null,
      rates: latest
        ? {
            inBps: latest.inBps,
            outBps: latest.outBps,
            errorsPerMin: latest.errorsPerMin,
            history: (rates ?? []).map((sample) => ({ t: new Date(sample.t).toISOString(), inBps: sample.inBps, outBps: sample.outBps })),
          }
        : null,
      discovered,
      diffs: plannedPort && discovered ? diffPort(plannedPort, discovered) : [],
      lldp,
      uplink,
      macs,
      devices: [],
    })
  }

  return {
    id: device.id,
    name: device.name,
    manufacturer: device.manufacturer,
    model: device.model,
    managementIp: device.managementIp,
    location: [device.location, device.rack].filter((part, index, all) => part && all.indexOf(part) === index).join(' · '),
    layout: device.layout,
    portCount: device.portCount + device.wanPortCount,
    sfpPortCount: device.sfpPortCount,
    reachability: reach.reachability,
    rttMs: reach.rttMs,
    snmp: health,
    sysName: raw.sys?.name ?? null,
    sysDescr: raw.sys?.descr ?? null,
    sysLocation: raw.sys?.location ?? null,
    uptimeSeconds: raw.sys?.upTimeTicks !== null && raw.sys ? Math.floor(raw.sys.upTimeTicks / 100 + (now - raw.sys.at) / 1000) : null,
    vlans: raw.vlans.map((vlan) => ({ vlanId: vlan.vlanId, name: vlan.name })),
    ports,
    lastPolledAt: raw.lastOkAt ? new Date(raw.lastOkAt).toISOString() : null,
    portMappingNote: raw.portMapNote,
  }
}

function discoveredConfig(raw: RawSwitch, bridgePort: number | null): DiscoveredPortConfig | null {
  if (bridgePort === null || raw.vlans.length === 0) return null
  const untagged: number[] = []
  const tagged: number[] = []
  for (const vlan of raw.vlans) {
    const egress = vlan.egressBridgePorts.includes(bridgePort)
    const isUntagged = vlan.untaggedBridgePorts.includes(bridgePort)
    if (isUntagged) untagged.push(vlan.vlanId)
    else if (egress) tagged.push(vlan.vlanId)
  }
  const pvid = raw.pvid.get(bridgePort) ?? untagged[0] ?? null
  return {
    pvid,
    untaggedVlanIds: untagged,
    taggedVlanIds: tagged,
    mode: tagged.length > 0 ? 'trunk' : untagged.length > 0 || pvid !== null ? 'access' : 'unknown',
  }
}

/** Planned vs discovered: only differences that matter operationally. */
export function diffPort(planned: PlannedPort, discovered: DiscoveredPortConfig): PortDiff[] {
  const diffs: PortDiff[] = []
  if (discovered.mode === 'unknown' || planned.mode === 'unused') return diffs
  if (planned.mode === 'access') {
    if (discovered.mode === 'trunk') diffs.push({ kind: 'mode', planned: 'access', discovered: 'trunk' })
    if (planned.accessVlanId !== null && discovered.pvid !== planned.accessVlanId)
      diffs.push({ kind: 'access-vlan', planned: planned.accessVlanId, discovered: discovered.pvid })
    return diffs
  }
  // trunk / hybrid
  if (discovered.mode === 'access') diffs.push({ kind: 'mode', planned: planned.mode, discovered: 'access' })
  if (planned.nativeVlanId !== null && discovered.pvid !== planned.nativeVlanId)
    diffs.push({ kind: 'native-vlan', planned: planned.nativeVlanId, discovered: discovered.pvid })
  const carried = new Set([...discovered.taggedVlanIds, ...discovered.untaggedVlanIds, ...(discovered.pvid !== null ? [discovered.pvid] : [])])
  const missing = planned.taggedVlanIds.filter((vlan) => !carried.has(vlan))
  if (missing.length) diffs.push({ kind: 'missing-tagged', vlanIds: missing })
  const expected = new Set([...planned.taggedVlanIds, ...(planned.nativeVlanId !== null ? [planned.nativeVlanId] : [])])
  const extra = discovered.taggedVlanIds.filter((vlan) => !expected.has(vlan) && vlan !== 1)
  if (extra.length) diffs.push({ kind: 'extra-tagged', vlanIds: extra })
  return diffs
}
