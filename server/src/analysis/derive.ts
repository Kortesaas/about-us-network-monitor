import type { MonitorState, Summary } from '@shared/types'
import type { Store } from '../state/store.js'
import { buildSwitches } from './switches.js'
import { buildDevices } from './devices.js'
import { buildInfra } from './infra.js'
import { buildVlans } from './vlans.js'
import { buildTopology } from './topology.js'
import { buildProblems } from './checks.js'
import { buildInternet } from './internet.js'

export type Derived = Pick<MonitorState, 'summary' | 'internet' | 'vlans' | 'infra' | 'switches' | 'devices' | 'topology' | 'problems' | 'plannedDevices' | 'subnets'>

/** Raw observations → everything the UI shows, in dependency order. */
export function deriveState(store: Store, now: number): Derived {
  const switches = buildSwitches(store, now)
  const devices = buildDevices(store, switches, now)
  // Attribute located devices back to their ports.
  const byMac = new Map<string, (typeof devices)[number]>()
  for (const device of devices) for (const mac of device.macs) byMac.set(mac, device)
  for (const sw of switches)
    for (const port of sw.ports) {
      for (const entry of port.macs) entry.deviceId = byMac.get(entry.mac)?.id ?? null
      const located = devices.filter((device) => device.location?.switchId === sw.id && device.location.port === port.number && device.online)
      port.devices = located.map((device) => ({ id: device.id, name: device.name, ip: device.primaryIp, vlanId: device.vlanId }))
    }
  const infra = buildInfra(store, switches, devices, now)
  const vlans = buildVlans(store, switches, devices, now)
  const topology = buildTopology(store, switches, infra, devices)
  const internet = buildInternet(store, now)
  const problems = buildProblems(store, switches, infra, devices, vlans, internet, now)
  return {
    summary: summarize(switches, infra, devices, vlans, problems),
    internet,
    vlans,
    infra,
    switches,
    devices,
    topology,
    problems,
    plannedDevices: store.inventory.devices,
    subnets: store.inventory.subnets,
  }
}

function summarize(
  switches: Derived['switches'],
  infra: Derived['infra'],
  devices: Derived['devices'],
  vlans: Derived['vlans'],
  problems: Derived['problems'],
): Summary {
  const visible = devices.filter((device) => !device.macOnly && !device.known?.ignored)
  const ports = switches.flatMap((sw) => sw.ports)
  const critical = problems.filter((problem) => problem.severity === 'critical').length
  const warning = problems.filter((problem) => problem.severity === 'warning').length
  const used = infra.filter((item) => item.inUse)
  const infraOnline = used.filter((item) => item.reachability === 'online').length
  const health: Summary['health'] =
    used.length === 0 && switches.length === 0
      ? 'unknown'
      : critical > 0
        ? 'critical'
        : warning > 0 || infraOnline < used.length
          ? 'degraded'
          : 'ok'
  return {
    infraTotal: used.length,
    infraOnline,
    infraUnused: infra.length - used.length,
    switchesTotal: switches.filter((sw) => used.some((item) => item.id === sw.id)).length,
    switchesSnmpOk: switches.filter((sw) => sw.snmp.ok && used.some((item) => item.id === sw.id)).length,
    devicesOnline: visible.filter((device) => device.online).length,
    devicesLocated: visible.filter((device) => device.online && device.location).length,
    devicesUnlocated: visible.filter((device) => device.online && !device.location).length,
    devicesStale: visible.filter((device) => device.status === 'stale').length,
    devicesUnknown: visible.filter((device) => device.online && !device.known && !device.infraId).length,
    devicesFavoriteOffline: visible.filter((device) => device.known?.favorite && !device.online).length,
    vlansPlanned: vlans.filter((vlan) => vlan.planned).length,
    vlansDiscovered: vlans.filter((vlan) => vlan.presentOn.some((item) => item.present)).length,
    portsUp: ports.filter((port) => port.link?.operUp).length,
    portsTotal: ports.filter((port) => port.link).length,
    problemsCritical: critical,
    problemsWarning: warning,
    problemsInfo: problems.length - critical - warning,
    health,
  }
}
