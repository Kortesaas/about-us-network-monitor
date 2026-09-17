import type { DeviceState, SwitchState, VlanState } from '@shared/types'
import type { Store } from '../state/store.js'
import { reachabilityFor } from './switches.js'

const FALLBACK_COLORS = ['#f59e0b', '#14b8a6', '#ec4899', '#8b5cf6', '#84cc16']

export function buildVlans(store: Store, switches: SwitchState[], devices: DeviceState[], now: number): VlanState[] {
  const ids = new Set<number>(store.inventory.vlans.map((vlan) => vlan.vlanId))
  for (const sw of switches) for (const vlan of sw.vlans) ids.add(vlan.vlanId)
  const result: VlanState[] = []
  let fallbackIndex = 0
  for (const vlanId of [...ids].sort((a, b) => a - b)) {
    const planned = store.inventory.vlans.find((vlan) => vlan.vlanId === vlanId) ?? null
    const subnet = store.inventory.subnets.find((item) => item.vlanId === vlanId) ?? null
    const discoveredName = switches.map((sw) => sw.vlans.find((vlan) => vlan.vlanId === vlanId)?.name).find(Boolean) ?? null
    const gateway = subnet?.gateway ? reachabilityFor(store, subnet.gateway, now) : null
    const members = devices.filter((device) => device.vlanId === vlanId && !device.macOnly && !device.known?.ignored)
    const ports: VlanState['ports'] = []
    for (const sw of switches)
      for (const port of sw.ports) {
        const carried = port.discovered
          ? port.discovered.untaggedVlanIds.includes(vlanId) || port.discovered.taggedVlanIds.includes(vlanId) || port.discovered.pvid === vlanId
          : port.planned
            ? port.planned.accessVlanId === vlanId || port.planned.nativeVlanId === vlanId || port.planned.taggedVlanIds.includes(vlanId)
            : false
        if (!carried) continue
        const tagged = port.discovered ? port.discovered.taggedVlanIds.includes(vlanId) : Boolean(port.planned?.taggedVlanIds.includes(vlanId))
        ports.push({ switchId: sw.id, switchName: sw.name, port: port.number, tagged, up: port.link?.operUp ?? false })
      }
    result.push({
      vlanId,
      name: planned?.name ?? discoveredName ?? `VLAN ${vlanId}`,
      color: planned?.color ?? FALLBACK_COLORS[fallbackIndex++ % FALLBACK_COLORS.length]!,
      description: planned?.description ?? (planned ? '' : 'Discovered on a switch but not part of the plan.'),
      planned: planned !== null,
      subnet,
      gatewayReachability: gateway?.reachability ?? null,
      gatewayRttMs: gateway?.rttMs ?? null,
      deviceCount: members.length,
      onlineDeviceCount: members.filter((device) => device.online).length,
      presentOn: switches.map((sw) => ({
        switchId: sw.id,
        switchName: sw.name,
        present: sw.vlans.length ? sw.vlans.some((vlan) => vlan.vlanId === vlanId) : false,
      })),
      ports,
    })
  }
  return result
}
