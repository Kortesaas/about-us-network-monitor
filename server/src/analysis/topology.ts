import type { DeviceState, InfraState, SwitchState, TopologyEdge, TopologyNode } from '@shared/types'
import type { Store } from '../state/store.js'

/**
 * Live graph from LLDP, with planned infrastructure as the backbone. Devices
 * (clients) hang off the port they were located on so "where is it plugged
 * in" is visible without opening a switch.
 */
export function buildTopology(store: Store, switches: SwitchState[], infra: InfraState[], devices: DeviceState[]) {
  const nodes = new Map<string, TopologyNode>()
  const edges: TopologyEdge[] = []
  const inventoryById = new Map(store.inventory.devices.map((item) => [item.id, item]))

  for (const item of infra) {
    const planned = inventoryById.get(item.id)
    const sw = switches.find((candidate) => candidate.id === item.id)
    nodes.set(item.id, {
      id: item.id,
      kind: item.type,
      name: item.name,
      subtitle: [item.manufacturer, item.model].filter(Boolean).join(' '),
      ip: item.managementIp,
      reachability: item.reachability,
      planned: true,
      inUse: item.inUse,
      hint: planned?.position ?? null,
      // SFP cages planned "just in case" are not missing links; copper trunks and SFPs that had link are.
      danglingTrunks: sw
        ? sw.ports
            .filter((port) => port.planned?.mode === 'trunk' && port.lldp.length === 0 && (store.portsSeenUp.has(`${sw.id}:${port.number}`) || port.link?.operUp))
            .map((port) => ({ port: port.number, name: port.planned?.name || `Port ${port.number}`, up: port.link?.operUp ?? false }))
        : [],
    })
  }

  const seen = new Set<string>()
  for (const sw of switches) {
    for (const port of sw.ports) {
      for (const neighbor of port.lldp) {
        let targetId = neighbor.deviceId
        if (!targetId) {
          targetId = `lldp:${neighbor.chassisId || neighbor.sysName || neighbor.managementIp || `${sw.id}-${port.number}`}`
          if (!nodes.has(targetId))
            nodes.set(targetId, {
              id: targetId,
              kind: guessKind(neighbor.sysDescription),
              name: neighbor.sysName || neighbor.managementIp || neighbor.chassisId || 'LLDP neighbour',
              subtitle: neighbor.sysDescription.slice(0, 60),
              ip: neighbor.managementIp,
              reachability: 'unknown',
              planned: false,
              inUse: true,
              hint: null,
              danglingTrunks: [],
            })
        }
        // One edge per physical link: switch-to-switch links show up from both ends.
        const key = [sw.id, targetId].sort().join('|') + `|${[`${sw.id}:${port.number}`, `${targetId}:${neighbor.portId}`].sort().join('|')}`
        const reverseKey = findReverse(edges, sw.id, port.number, targetId)
        if (reverseKey) {
          reverseKey.targetPort = port.number
          reverseKey.targetPortName = port.planned?.name || null
          continue
        }
        if (seen.has(key)) continue
        seen.add(key)
        const remotePort = Number.parseInt(neighbor.portId.match(/(\d+)$/)?.[1] ?? '', 10)
        const warnings: string[] = []
        if (port.diffs.length) warnings.push(`${port.diffs.length} config difference${port.diffs.length > 1 ? 's' : ''} on ${sw.name} port ${port.number}`)
        if (port.link && !port.link.operUp) warnings.push('link down')
        if (port.rates && port.rates.errorsPerMin > store.settings.thresholds.portErrorsPerMinute) warnings.push('errors increasing')
        edges.push({
          id: `lldp:${sw.id}:${port.number}:${targetId}`,
          source: sw.id,
          sourcePort: port.number,
          sourcePortName: port.planned?.name || null,
          target: targetId,
          targetPort: Number.isFinite(remotePort) ? remotePort : null,
          targetPortName: neighbor.portDescription || null,
          origin: 'lldp',
          up: port.link?.operUp ?? true,
          speedMbps: port.link?.speedMbps ?? null,
          vlanIds: port.discovered ? [...port.discovered.untaggedVlanIds, ...port.discovered.taggedVlanIds] : (port.planned ? [...(port.planned.nativeVlanId !== null ? [port.planned.nativeVlanId] : []), ...port.planned.taggedVlanIds] : []),
          warnings,
        })
      }
    }
  }

  // Clients hang off their located port; only online, non-ignored, non-infra devices.
  for (const device of devices) {
    if (!device.online || device.infraId || device.macOnly || device.known?.ignored || !device.location) continue
    nodes.set(device.id, {
      id: device.id,
      kind: 'unknown',
      name: device.name,
      subtitle: [device.primaryIp, device.vlanId !== null ? `VLAN ${device.vlanId}` : null].filter(Boolean).join(' · '),
      ip: device.primaryIp,
      reachability: 'online',
      planned: false,
      inUse: true,
      hint: null,
      danglingTrunks: [],
    })
    edges.push({
      id: `client:${device.id}`,
      source: device.location.switchId,
      sourcePort: device.location.port,
      sourcePortName: device.location.portName,
      target: device.id,
      targetPort: null,
      targetPortName: null,
      origin: 'client',
      up: true,
      speedMbps: null,
      vlanIds: device.vlanId !== null ? [device.vlanId] : [],
      warnings: [],
    })
  }

  return { nodes: [...nodes.values()], edges }
}

function findReverse(edges: TopologyEdge[], switchId: string, port: number, targetId: string) {
  return edges.find(
    (edge) => edge.origin === 'lldp' && edge.source === targetId && edge.target === switchId && (edge.targetPort === port || edge.targetPort === null),
  )
}

function guessKind(sysDescr: string): TopologyNode['kind'] {
  if (/switch/i.test(sysDescr)) return 'switch'
  if (/router|gateway|lancom/i.test(sysDescr)) return 'router'
  if (/access point|\bap\b|eap|wireless/i.test(sysDescr)) return 'access-point'
  return 'unknown'
}
