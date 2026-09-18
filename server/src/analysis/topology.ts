import type { DeviceState, InfraState, InternetState, SwitchState, TopologyEdge, TopologyNode, TrafficState } from '@shared/types'
import type { Store } from '../state/store.js'

/**
 * Live graph from LLDP, with planned infrastructure as the backbone. Devices
 * (clients) hang off the port they were located on so "where is it plugged
 * in" is visible without opening a switch.
 */
export function buildTopology(store: Store, switches: SwitchState[], infra: InfraState[], devices: DeviceState[], internet: InternetState, traffic: TrafficState) {
  const nodes = new Map<string, TopologyNode>()
  const edges: TopologyEdge[] = []
  const inventoryById = new Map(store.inventory.devices.map((item) => [item.id, item]))
  const inUseInfra = infra.filter((item) => item.inUse)
  const inUseInfraIds = new Set(inUseInfra.map((item) => item.id))
  const switchById = new Map(switches.map((item) => [item.id, item]))

  for (const item of inUseInfra) {
    const planned = inventoryById.get(item.id)
    const sw = switchById.get(item.id)
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
  const paired = new Set<string>()
  for (const sw of switches) {
    if (!nodes.has(sw.id)) continue
    for (const port of sw.ports) {
      for (const neighbor of port.lldp) {
        let targetId = neighbor.deviceId
        if (targetId && inventoryById.has(targetId) && !inUseInfraIds.has(targetId)) continue
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
        const reverse = findReverse(edges, paired, sw.id, port.number, targetId)
        if (reverse) {
          paired.add(reverse.id)
          reverse.targetPort = port.number
          reverse.targetPortName = port.planned?.name || null
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

  // Many APs and small endpoints do not speak LLDP. When the switch MAC table can
  // locate planned infrastructure on a port, draw that as a weaker live link.
  for (const item of inUseInfra) {
    if (!item.locatedAt || item.locatedAt.switchId === item.id) continue
    if (!nodes.has(item.id) || !nodes.has(item.locatedAt.switchId)) continue
    if (hasEdgeBetween(edges, item.locatedAt.switchId, item.id)) continue
    const sw = switchById.get(item.locatedAt.switchId)
    const port = sw?.ports.find((candidate) => candidate.number === item.locatedAt?.port) ?? null
    const warnings: string[] = []
    if (port?.diffs.length) warnings.push(`${port.diffs.length} config difference${port.diffs.length > 1 ? 's' : ''} on ${sw?.name ?? item.locatedAt.switchName} port ${port.number}`)
    if (port?.link && !port.link.operUp) warnings.push('link down')
    if (port?.rates && port.rates.errorsPerMin > store.settings.thresholds.portErrorsPerMinute) warnings.push('errors increasing')
    edges.push({
      id: `fdb:${item.locatedAt.switchId}:${item.locatedAt.port}:${item.id}`,
      source: item.locatedAt.switchId,
      sourcePort: item.locatedAt.port,
      sourcePortName: port?.planned?.name || null,
      target: item.id,
      targetPort: null,
      targetPortName: null,
      origin: 'fdb',
      up: port?.link?.operUp ?? item.reachability !== 'offline',
      speedMbps: port?.link?.speedMbps ?? null,
      vlanIds: port?.discovered
        ? [...port.discovered.untaggedVlanIds, ...port.discovered.taggedVlanIds]
        : (port?.planned ? [...(port.planned.nativeVlanId !== null ? [port.planned.nativeVlanId] : []), ...port.planned.taggedVlanIds] : []),
      warnings,
    })
  }

  // An AP plugged into the router (or any device behind an uplink whose far end
  // has no readable MAC table) can only be placed *behind* that neighbour: its
  // MAC shows up on the uplink port next to the neighbour's LLDP entry.
  const deviceByInfra = new Map(devices.filter((device) => device.infraId).map((device) => [device.infraId!, device]))
  for (const item of inUseInfra) {
    if (!item.mac || !nodes.has(item.id) || edges.some((edge) => edge.source === item.id || edge.target === item.id)) continue
    const behind = deviceByInfra.get(item.id)?.behind ?? null
    let via: string | null = behind && nodes.has(behind.infraId) ? behind.infraId : null
    for (const sw of switches) {
      if (via) break
      for (const port of sw.ports) {
        if (!port.uplink || !port.macs.some((entry) => entry.mac === item.mac)) continue
        via = port.lldp.map((neighbor) => neighbor.deviceId).find((id): id is string => Boolean(id) && id !== item.id && nodes.has(id!) && !switchById.has(id!)) ?? null
        if (via) break
      }
    }
    if (!via) continue
    edges.push({
      id: `behind:${via}:${item.id}`,
      source: via,
      sourcePort: null,
      sourcePortName: behind?.devicePort ?? null,
      target: item.id,
      targetPort: null,
      targetPortName: null,
      origin: 'fdb',
      up: item.reachability !== 'offline',
      speedMbps: null,
      vlanIds: [],
      warnings: [],
    })
  }

  // Clients hang off their located port; only online, non-ignored, non-infra devices.
  for (const device of devices) {
    if (!device.online || device.infraId || device.macOnly || device.known?.ignored || (!device.location && !device.behind)) continue
    const parent = device.location ? device.location.switchId : device.behind!.infraId
    if (!nodes.has(parent)) continue
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
      source: parent,
      sourcePort: device.location?.port ?? null,
      sourcePortName: device.location?.portName ?? device.behind?.devicePort ?? null,
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

  // The internet as the root: hangs above the router whose WAN interface carries it (the one the WAN
  // counters come from, else the router that owns the gateways), coloured by the WAN check.
  const wanRouter = (traffic.wan && inUseInfra.find((item) => item.id === traffic.wan!.routerId)) ?? inUseInfra.find((item) => item.type === 'router') ?? null
  if (wanRouter && nodes.has(wanRouter.id)) {
    const ifaces = traffic.wan?.interfaces.map((iface) => iface.name).join(', ') ?? ''
    nodes.set('internet', {
      id: 'internet',
      kind: 'internet',
      name: 'Internet',
      subtitle: !internet.enabled ? 'check disabled' : internet.status === 'online' ? 'connected' : internet.status === 'offline' ? 'no connection' : internet.status === 'stale' ? 'missed recent checks' : 'checking…',
      ip: null,
      reachability: internet.enabled ? internet.status : 'unknown',
      planned: true,
      inUse: true,
      hint: null,
      danglingTrunks: [],
    })
    edges.unshift({
      id: `wan:${wanRouter.id}`,
      source: 'internet',
      sourcePort: null,
      sourcePortName: ifaces || null,
      target: wanRouter.id,
      targetPort: null,
      targetPortName: null,
      origin: 'wan',
      up: !internet.enabled || internet.status === 'online',
      speedMbps: null,
      vlanIds: [],
      warnings: internet.enabled && internet.status !== 'online' ? ['internet unreachable'] : internet.dns.ok === false ? ['DNS failing'] : [],
    })
  }

  return { nodes: [...nodes.values()], edges }
}


function hasEdgeBetween(edges: TopologyEdge[], a: string, b: string) {
  return edges.some((edge) => (edge.source === a && edge.target === b) || (edge.source === b && edge.target === a))
}

/**
 * The edge the far end already recorded for this link. The remote port number
 * parsed from LLDP `portId` is only a guess (Dell reports an interface index),
 * so after the exact match any not-yet-paired edge between the two devices is
 * taken — one physical link must never be drawn twice.
 */
function findReverse(edges: TopologyEdge[], paired: Set<string>, switchId: string, port: number, targetId: string) {
  const candidates = edges.filter((edge) => edge.origin === 'lldp' && edge.source === targetId && edge.target === switchId && !paired.has(edge.id))
  return candidates.find((edge) => edge.targetPort === port) ?? candidates.find((edge) => edge.targetPort === null) ?? candidates[0] ?? null
}

function guessKind(sysDescr: string): TopologyNode['kind'] {
  if (/switch/i.test(sysDescr)) return 'switch'
  if (/router|gateway|lancom/i.test(sysDescr)) return 'router'
  if (/access point|\bap\b|eap|wireless/i.test(sysDescr)) return 'access-point'
  return 'unknown'
}
