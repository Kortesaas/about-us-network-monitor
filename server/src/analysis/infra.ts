import type { DeviceState, InfraState, SwitchState } from '@shared/types'
import type { Store } from '../state/store.js'
import { reachabilityFor, snmpHealth } from './switches.js'
import { isMonitoredIp } from '../inventory/plan.js'

export function buildInfra(store: Store, switches: SwitchState[], devices: DeviceState[], now: number): InfraState[] {
  const infraTypes = new Set(['switch', 'router', 'access-point', 'server', 'computer'])
  const switchById = new Map(switches.map((sw) => [sw.id, sw]))
  const deviceByInfra = new Map(devices.filter((device) => device.infraId).map((device) => [device.infraId!, device]))
  return store.inventory.devices
    .filter((device) => infraTypes.has(device.type) && device.managementIp)
    .map((planned) => {
      const monitored = isMonitoredIp(store.inventory, planned.managementIp)
      const use = store.infraUse.get(planned.id) ?? null
      const reach = monitored ? reachabilityFor(store, planned.managementIp, now) : { reachability: 'unknown' as const, rttMs: null, lastSeenAt: null }
      const sw = switchById.get(planned.id)
      const sys = store.sysInfo.get(planned.id) ?? null
      const device = deviceByInfra.get(planned.id)
      const mac = device?.primaryMac ?? null
      const ap = mac ? store.accessPoints.get(mac) : [...store.accessPoints.values()].find((item) => item.ip === planned.managementIp)
      // LLDP beats the FDB for where a switch/router/AP hangs.
      let locatedAt: InfraState['locatedAt'] = null
      for (const other of switches) {
        if (other.id === planned.id) continue
        const port = other.ports.find((item) => item.lldp.some((neighbor) => neighbor.deviceId === planned.id))
        if (port) {
          locatedAt = { switchId: other.id, switchName: other.name, port: port.number }
          break
        }
      }
      if (!locatedAt && device?.location)
        locatedAt = { switchId: device.location.switchId, switchName: device.location.switchName, port: device.location.port }
      return {
        id: planned.id,
        type: planned.type,
        name: planned.name,
        manufacturer: planned.manufacturer,
        model: planned.model,
        managementIp: planned.managementIp,
        location: [planned.location, planned.rack].filter((part, index, all) => part && all.indexOf(part) === index).join(' · '),
        monitored,
        inUse: use?.inUse === true,
        inUseSource: use?.source ?? null,
        inUseSince: use?.since ?? null,
        reachability: reach.reachability,
        rttMs: reach.rttMs,
        lastSeenAt: reach.lastSeenAt ? new Date(reach.lastSeenAt).toISOString() : (device?.lastSeenAt ?? null),
        snmp: !monitored ? null : sw ? sw.snmp : sys ? snmpHealth(sys, true, now, Math.max(store.settings.polling.snmpConfigSeconds * 3, 300) * 1000) : null,
        sysName: sw?.sysName ?? sys?.name ?? null,
        sysDescr: sw?.sysDescr ?? sys?.descr ?? null,
        uptimeSeconds:
          sw?.uptimeSeconds ?? (sys?.upTimeTicks !== null && sys ? Math.floor(sys.upTimeTicks / 100 + (now - sys.at) / 1000) : null),
        locatedAt,
        mac,
        wireless:
          planned.type === 'access-point'
            ? ap
              ? { clients: ap.clients, ssids: ap.ssids, radios: ap.radios }
              : null
            : null,
      }
    })
}
