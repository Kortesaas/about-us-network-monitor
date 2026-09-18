import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { PlannedDevice, PlannedPort, PlannedSubnet, PlannedVlan } from '@shared/types'
import { cidrContains, parseCidr } from '@shared/ip'
import { config } from '../config.js'
import { log } from '../logger.js'

const logger = log('inventory')

/**
 * Loose schema for the planner's project JSON. Only the fields the monitor
 * needs are validated; everything else (labels, print templates…) is ignored
 * so a newer planner export still loads.
 */
const projectSchema = z.object({
  project: z.object({ name: z.string(), updatedAt: z.string().optional() }).passthrough(),
  vlans: z.array(
    z.object({
      vlanId: z.number().int(),
      name: z.string(),
      color: z.string().default('#64748b'),
      description: z.string().default(''),
      purpose: z.string().default(''),
      enabled: z.boolean().default(true),
    }),
  ),
  subnets: z.array(
    z.object({
      name: z.string(),
      cidr: z.string(),
      vlanId: z.number().int().nullable(),
      gateway: z.string().default(''),
      dhcpStart: z.string().default(''),
      dhcpEnd: z.string().default(''),
      dns: z.array(z.string()).default([]),
    }),
  ),
  locations: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  racks: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  devices: z.array(
    z.object({
      id: z.string(),
      type: z.enum(['switch', 'router', 'access-point', 'server', 'computer', 'media', 'custom']),
      name: z.string(),
      manufacturer: z.string().default(''),
      model: z.string().default(''),
      locationId: z.string().nullable().default(null),
      rackId: z.string().nullable().default(null),
      managementIp: z.string().default(''),
      managementVlanId: z.number().int().nullable().default(null),
      portCount: z.number().int().nonnegative().default(0),
      wanPortCount: z.number().int().nonnegative().default(0),
      sfpPortCount: z.number().int().nonnegative().default(0),
      layout: z.enum(['sequential', 'odd-even', 'bottom-up']).default('odd-even'),
      position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
    }),
  ),
  ports: z.array(
    z.object({
      deviceId: z.string(),
      number: z.number().int().positive(),
      role: z.enum(['lan', 'wan', 'sfp']).default('lan'),
      name: z.string().default(''),
      mode: z.enum(['access', 'trunk', 'hybrid', 'unused']).default('unused'),
      accessVlanId: z.number().int().nullable().default(null),
      nativeVlanId: z.number().int().nullable().default(null),
      taggedVlanIds: z.array(z.number().int()).default([]),
      poe: z.boolean().default(false),
      speed: z.string().default(''),
      connectedDevice: z.string().default(''),
    }),
  ),
})

export type Inventory = {
  projectName: string
  updatedAt: string | null
  source: string
  vlans: PlannedVlan[]
  subnets: PlannedSubnet[]
  devices: PlannedDevice[]
}

export function parseInventory(raw: unknown, source: string): Inventory {
  const data = projectSchema.parse(raw)
  const locationName = new Map(data.locations.map((item) => [item.id, item.name]))
  const rackName = new Map(data.racks.map((item) => [item.id, item.name]))
  const portsByDevice = new Map<string, PlannedPort[]>()
  for (const port of data.ports) {
    const list = portsByDevice.get(port.deviceId) ?? []
    list.push({
      number: port.number,
      role: port.role,
      name: port.name,
      mode: port.mode,
      accessVlanId: port.accessVlanId,
      nativeVlanId: port.nativeVlanId,
      taggedVlanIds: [...port.taggedVlanIds].sort((a, b) => a - b),
      poe: port.poe,
      speed: port.speed,
      connectedDevice: port.connectedDevice,
    })
    portsByDevice.set(port.deviceId, list)
  }
  return {
    projectName: data.project.name,
    updatedAt: data.project.updatedAt ?? null,
    source,
    vlans: data.vlans
      .filter((vlan) => vlan.enabled)
      .map((vlan) => ({
        vlanId: vlan.vlanId,
        name: vlan.name,
        color: vlan.color,
        description: vlan.description,
        purpose: vlan.purpose,
      }))
      .sort((a, b) => a.vlanId - b.vlanId),
    subnets: data.subnets.map((subnet) => ({
      vlanId: subnet.vlanId,
      name: subnet.name,
      cidr: subnet.cidr,
      gateway: subnet.gateway,
      dhcpStart: subnet.dhcpStart,
      dhcpEnd: subnet.dhcpEnd,
      dns: subnet.dns,
    })),
    devices: data.devices.map((device) => ({
      id: device.id,
      type: device.type,
      name: device.name,
      manufacturer: device.manufacturer.trim(),
      model: device.model,
      location: locationName.get(device.locationId ?? '') ?? '',
      rack: rackName.get(device.rackId ?? '') ?? '',
      managementIp: device.managementIp.trim(),
      managementVlanId: device.managementVlanId,
      portCount: device.portCount,
      sfpPortCount: device.sfpPortCount,
      wanPortCount: device.wanPortCount,
      layout: device.layout,
      position: device.position,
      ports: (portsByDevice.get(device.id) ?? []).sort((a, b) => a.number - b.number),
    })),
  }
}

/** The planning JSON: `data/inventory.json` (uploaded via the UI) wins over the shipped `config/inventory.json`. */
export function loadInventory(): Inventory {
  const override = resolve(config.dataDir, 'inventory.json')
  const candidates = [override, config.inventoryFile]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      const inventory = parseInventory(JSON.parse(readFileSync(file, 'utf8')), file)
      logger.info(`loaded "${inventory.projectName}" from ${file} (${inventory.devices.length} devices)`)
      return inventory
    } catch (error) {
      logger.error(`could not load inventory from ${file}`, error)
    }
  }
  logger.warn('no inventory file found; running with an empty plan')
  return { projectName: 'Event Network', updatedAt: null, source: 'none', vlans: [], subnets: [], devices: [] }
}

export const totalPorts = (device: PlannedDevice) => device.portCount + device.sfpPortCount + device.wanPortCount

/** Addresses outside every planned subnet (a WAN-side router, say) cannot be reached from the Pi and are not polled. */
export function isMonitoredIp(inventory: Pick<Inventory, 'subnets'>, ip: string) {
  if (inventory.subnets.length === 0) return true
  return inventory.subnets.some((subnet) => {
    const parsed = parseCidr(subnet.cidr)
    return parsed ? cidrContains(parsed, ip) : false
  })
}
