import type { PlannedDevice } from '@shared/types'
import { ETHERNET_IF_TYPES } from './oids.js'

export type InterfaceIdentity = { ifIndex: number; ifName: string | null; ifDescr: string | null; ifType: number | null }

const LOGICAL = /vlan|lag|port-?channel|^po\d|loopback|^lo\b|cpu|null|tunnel|^ch\d|^bond|^br|stack/i

/**
 * Works out which physical port number an interface is. Vendors name ports
 * differently — Dell `Gi1/0/3` / `Te1/0/1`, TP-Link `gigabitEthernet 1/0/3`,
 * Allied `Port 3` — so the name is parsed first and the result is validated
 * against the planned port count; when that fails the Ethernet interfaces are
 * simply numbered in ifIndex order.
 */
export function mapInterfacesToPorts(
  interfaces: InterfaceIdentity[],
  device: PlannedDevice,
): { map: Map<number, number>; note: string } {
  const total = device.portCount + device.sfpPortCount + device.wanPortCount
  const physical = interfaces.filter((item) => {
    const label = `${item.ifName ?? ''} ${item.ifDescr ?? ''}`
    if (item.ifType !== null && !ETHERNET_IF_TYPES.has(item.ifType)) return false
    return !LOGICAL.test(label)
  })
  const named = new Map<number, number>()
  let rule = ''
  for (const item of physical) {
    const parsed = parsePortNumber(item, device)
    if (parsed === null) continue
    named.set(item.ifIndex, parsed.port)
    rule = rule || parsed.rule
  }
  const values = [...named.values()]
  const unique = new Set(values).size === values.length
  const inRange = values.every((port) => port >= 1 && port <= Math.max(total, 1))
  if (values.length > 0 && unique && inRange)
    return { map: named, note: `${values.length} ports mapped from interface names (${rule})` }

  const sequential = new Map<number, number>()
  physical
    .sort((a, b) => a.ifIndex - b.ifIndex)
    .slice(0, total || physical.length)
    .forEach((item, index) => sequential.set(item.ifIndex, index + 1))
  return {
    map: sequential,
    note: `${sequential.size} Ethernet interfaces numbered in ifIndex order (names did not parse cleanly)`,
  }
}

export function parsePortNumber(item: InterfaceIdentity, device: PlannedDevice): { port: number; rule: string } | null {
  const candidates = [item.ifName, item.ifDescr].filter((value): value is string => Boolean(value))
  for (const label of candidates) {
    // Dell N-series: Gi1/0/N are the copper ports, Te1/0/N the SFP+ cages after them.
    const dell = label.match(/^(Gi|Te|Tw|Fo)\s*\d+\/\d+\/(\d+)$/i)
    if (dell) {
      const n = Number(dell[2])
      const prefix = dell[1]!.toLowerCase()
      if (prefix === 'gi') return { port: n, rule: 'Dell Gi/Te naming' }
      return { port: device.portCount + n, rule: 'Dell Gi/Te naming' }
    }
    // TP-Link / Cisco-style: gigabitEthernet 1/0/N, GigabitEthernet1/0/N, ten-gigabitEthernet 1/0/N
    const slotted = label.match(/(?:ethernet|eth|ge|xe|te|gi)\s*\d+\/\d+\/(\d+)$/i)
    if (slotted) return { port: Number(slotted[1]), rule: 'slot/unit/port naming' }
    // Allied Telesis & many SOHO switches: "Port 3", "port3", "Ethernet Port 3", "eth3", "3"
    const simple = label.match(/(?:^|[^\d])(\d{1,3})$/)
    if (simple) return { port: Number(simple[1]), rule: 'trailing port number' }
  }
  return null
}

/** Speeds the planner writes ("1 Gbps", "10 Gbps") as Mbit/s, for comparison with ifHighSpeed. */
export function plannedSpeedMbps(speed: string): number | null {
  const match = speed.match(/([\d.]+)\s*(g|m)/i)
  if (!match) return null
  const value = Number(match[1])
  return match[2]!.toLowerCase() === 'g' ? value * 1000 : value
}
