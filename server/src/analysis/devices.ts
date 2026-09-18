import { networkInterfaces } from 'node:os'
import type { DeviceLocation, DeviceState, KnownDeviceMeta, PlannedDevice, SignalQuality, SwitchState } from '@shared/types'
import { normalizeMac, isLocallyAdministered } from '@shared/mac'
import { cidrContains, parseCidr } from '@shared/ip'
import type { Store, DeviceTrack } from '../state/store.js'
import { vendorForMac } from './vendor.js'
import { isMonitoredIp } from '../inventory/plan.js'

type Group = {
  id: string
  macs: Set<string>
  ips: Set<string>
  known: KnownDeviceMeta | null
  infra: PlannedDevice | null
}

/**
 * Correlates every observation (ARP, ping, FDB, LLDP, wireless) into devices.
 * Identity is MAC-first: a MAC is a device, user metadata can merge several
 * MACs, and an IP that answers pings without any MAC becomes an IP-only device.
 */
export function buildDevices(store: Store, switches: SwitchState[], now: number): DeviceState[] {
  const { thresholds } = store.settings
  const staleMs = thresholds.staleAfterSeconds * 1000
  const offlineMs = thresholds.offlineAfterSeconds * 1000
  const subnets = store.inventory.subnets
    .map((subnet) => ({ subnet, cidr: parseCidr(subnet.cidr) }))
    .filter((item): item is { subnet: (typeof store.inventory.subnets)[number]; cidr: NonNullable<ReturnType<typeof parseCidr>> } => item.cidr !== null)
  const vlanForIp = (ip: string) => subnets.find((item) => cidrContains(item.cidr, ip))?.subnet.vlanId ?? null
  const inventoryByIp = new Map(store.inventory.devices.filter((d) => d.managementIp).map((d) => [d.managementIp, d]))
  // The router answers on every subnet's gateway address; those IPs are the router, not separate devices.
  const gateways = store.inventory.subnets.map((subnet) => subnet.gateway).filter(Boolean)
  const router = store.inventory.devices.find((device) => device.type === 'router' && gateways.includes(device.managementIp))
  for (const gateway of gateways) if (router && !inventoryByIp.has(gateway)) inventoryByIp.set(gateway, router)

  // Router MAC tables: MAC → the router LAN port it hangs on. A port carrying a switch's MAC (or a crowd of
  // MACs) is the router's uplink into the switched network and says nothing about where a device sits.
  const switchMacs = new Set<string>()
  for (const raw of store.switches.values()) for (const iface of raw.interfaces.values()) if (iface.physAddress) switchMacs.add(iface.physAddress)
  const routerPorts = new Map<string, { routerId: string; routerName: string; portName: string }>()
  for (const [routerId, raw] of store.routerTraffic) {
    if (!store.isInUse(routerId) || now - (raw.lastOkAt ?? 0) > staleMs) continue
    const routerName = store.inventory.devices.find((item) => item.id === routerId)?.name ?? routerId
    const perPort = new Map<number, Set<string>>()
    for (const entry of raw.fdb) perPort.set(entry.ifIndex, (perPort.get(entry.ifIndex) ?? new Set()).add(entry.mac))
    for (const entry of raw.fdb) {
      const macsOnPort = perPort.get(entry.ifIndex)!
      if (macsOnPort.size >= thresholds.uplinkMacThreshold || [...macsOnPort].some((mac) => switchMacs.has(mac))) continue
      routerPorts.set(entry.mac, { routerId, routerName, portName: entry.portName })
    }
  }
  const routerPortFor = (mac: string) => routerPorts.get(mac) ?? null

  /* ---- 1. group observations by identity ---- */
  const groups = new Map<string, Group>()
  const macToGroup = new Map<string, string>()
  const ipToGroup = new Map<string, string>()
  const ensure = (id: string, known: KnownDeviceMeta | null, infra: PlannedDevice | null) => {
    let group = groups.get(id)
    if (!group) {
      group = { id, macs: new Set(), ips: new Set(), known, infra }
      groups.set(id, group)
    }
    if (known && !group.known) group.known = known
    if (infra && !group.infra) group.infra = infra
    return group
  }
  for (const known of store.known.values()) {
    const group = ensure(known.id, known, null)
    for (const raw of known.macs) {
      const mac = normalizeMac(raw)
      if (!mac) continue
      group.macs.add(mac)
      macToGroup.set(mac, known.id)
    }
    for (const ip of known.ips) {
      group.ips.add(ip)
      ipToGroup.set(ip, known.id)
    }
  }
  const groupForMac = (mac: string) => {
    const existing = macToGroup.get(mac)
    if (existing) return groups.get(existing)!
    const group = ensure(`mac:${mac}`, null, null)
    group.macs.add(mac)
    macToGroup.set(mac, group.id)
    return group
  }

  // The Pi's own interfaces.
  for (const addresses of Object.values(networkInterfaces()))
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      const mac = normalizeMac(address.mac)
      if (!mac || mac === '00:00:00:00:00:00') continue
      const group = groupForMac(mac)
      group.ips.add(address.address)
      ipToGroup.set(address.address, group.id)
    }

  // IP ↔ MAC from ARP (router + local neighbour table).
  const arpByMac = new Map<string, { ip: string; at: number; reachable: boolean; source: 'router' | 'local' }[]>()
  const arpByIp = new Map<string, Set<string>>()
  for (const entry of store.arp.values()) {
    if (now - entry.at > offlineMs * 4) continue
    const list = arpByMac.get(entry.mac) ?? []
    list.push({ ip: entry.ip, at: entry.at, reachable: entry.reachable, source: entry.source })
    arpByMac.set(entry.mac, list)
    const macs = arpByIp.get(entry.ip) ?? new Set()
    macs.add(entry.mac)
    arpByIp.set(entry.ip, macs)
  }
  for (const [mac, entries] of arpByMac) {
    const group = groupForMac(mac)
    for (const entry of entries) {
      // A known device that claims this IP wins over an anonymous MAC.
      const claimed = ipToGroup.get(entry.ip)
      if (claimed && claimed !== group.id && groups.get(claimed)?.known) continue
      group.ips.add(entry.ip)
      if (!ipToGroup.has(entry.ip)) ipToGroup.set(entry.ip, group.id)
    }
  }

  // FDB and wireless observations create MAC groups too.
  const fdbByMac = new Map<string, { switchId: string; port: number; vlanId: number | null; seenAt: number; uplink: boolean }[]>()
  for (const sw of switches)
    for (const port of sw.ports)
      for (const entry of port.macs) {
        groupForMac(entry.mac)
        const list = fdbByMac.get(entry.mac) ?? []
        list.push({ switchId: sw.id, port: port.number, vlanId: entry.vlanId, seenAt: Date.parse(entry.lastSeenAt), uplink: port.uplink })
        fdbByMac.set(entry.mac, list)
      }
  for (const client of store.wirelessClients.values()) {
    if (now - client.at > offlineMs) continue
    const group = groupForMac(client.mac)
    if (client.ip) {
      group.ips.add(client.ip)
      if (!ipToGroup.has(client.ip)) ipToGroup.set(client.ip, group.id)
    }
  }

  // Pings that answered but have no MAC anywhere → IP-only devices.
  for (const ping of store.pings.values()) {
    if (ipToGroup.has(ping.ip)) continue
    if (router && gateways.includes(ping.ip)) continue
    if (!isMonitoredIp(store.inventory, ping.ip)) continue
    if (ping.lastAliveAt === null || now - ping.lastAliveAt > offlineMs) continue
    const group = ensure(`ip:${ping.ip}`, null, null)
    group.ips.add(ping.ip)
    ipToGroup.set(ping.ip, group.id)
  }

  // Planned infrastructure: attach by management IP (gateway addresses fold into the router).
  for (const group of groups.values())
    for (const ip of group.ips) {
      const planned = inventoryByIp.get(ip)
      if (planned) group.infra = planned
    }
  if (router) {
    const routerGroup = [...groups.values()].find((group) => group.infra?.id === router.id)
    if (routerGroup)
      for (const gateway of gateways) {
        const claimed = ipToGroup.get(gateway)
        if (claimed && claimed !== routerGroup.id && groups.get(claimed)?.id.startsWith('ip:')) groups.delete(claimed)
        routerGroup.ips.add(gateway)
        ipToGroup.set(gateway, routerGroup.id)
      }
  }
  // Planned devices nobody has seen still get an (offline) entry so the user notices.
  for (const planned of store.inventory.devices) {
    if (!planned.managementIp || !isMonitoredIp(store.inventory, planned.managementIp) || !store.isInUse(planned.id)) continue
    if ([...groups.values()].some((group) => group.infra?.id === planned.id)) continue
    const group = ensure(`infra:${planned.id}`, null, planned)
    group.ips.add(planned.managementIp)
    ipToGroup.set(planned.managementIp, group.id)
  }

  /* ---- 2. evaluate every group ---- */
  const switchById = new Map(switches.map((sw) => [sw.id, sw]))
  const devices: DeviceState[] = []
  for (const group of groups.values()) {
    // Infrastructure the Pi cannot reach is listed under infra as "not monitored", never as an offline device.
    if (group.infra && !isMonitoredIp(store.inventory, group.infra.managementIp)) continue
    const macs = [...group.macs].sort()
    const ips = [...group.ips].sort(compareIps)
    const sources = new Set<DeviceState['sources'][number]>()
    let lastConfirmed: number | null = null
    let lastSeen: number | null = null
    let rttMs: number | null = null
    const flags: string[] = []

    for (const ip of ips) {
      const ping = store.pings.get(ip)
      if (ping?.lastAliveAt) {
        sources.add('ping')
        lastConfirmed = max(lastConfirmed, ping.lastAliveAt)
        if (ping.alive) rttMs = ping.rttMs
      }
      const dns = store.dns.get(ip)
      if (dns?.hostname) sources.add('dns')
    }
    for (const mac of macs) {
      for (const entry of arpByMac.get(mac) ?? []) {
        sources.add(entry.source === 'local' ? 'neighbor' : 'arp')
        lastSeen = max(lastSeen, entry.at)
        if (entry.reachable) lastConfirmed = max(lastConfirmed, entry.at)
      }
      for (const entry of fdbByMac.get(mac) ?? []) {
        sources.add('fdb')
        lastSeen = max(lastSeen, entry.seenAt)
        // A MAC in a switch's forwarding table sent a frame within the aging time — that is proof of life.
        lastConfirmed = max(lastConfirmed, entry.seenAt)
      }
      const wireless = store.wirelessClients.get(mac)
      if (wireless && now - wireless.at <= offlineMs) {
        sources.add(wireless.source === 'omada' ? 'omada' : 'wifi')
        lastConfirmed = max(lastConfirmed, wireless.at)
      }
    }
    if (group.infra) sources.add('inventory')
    lastSeen = max(lastSeen, lastConfirmed)

    // Location: LLDP for infrastructure, else the newest FDB sighting on an edge port; uplink sightings are only hints.
    const sightings = macs.flatMap((mac) => fdbByMac.get(mac) ?? []).sort((a, b) => b.seenAt - a.seenAt)
    const lldpSighting = group.infra ? lldpLocation(switches, group.infra.id, now) : null
    const edge = lldpSighting ?? sightings.find((entry) => !entry.uplink && now - entry.seenAt <= staleMs)
    const uplinkOnly = !edge ? sightings.find((entry) => now - entry.seenAt <= staleMs) : undefined
    const isInfraLink = group.infra && (group.infra.type === 'switch' || group.infra.type === 'router')
    let chosen = edge ?? (isInfraLink ? uplinkOnly : undefined)
    // Only seen on uplinks: if one of them leads to a non-switch neighbour (the router's LAN ports, an
    // unmanaged box), the device sits one hop behind it — that is a location, not a mystery.
    let behind: DeviceState['behind'] = null
    if (!edge && !isInfraLink) {
      // The router's own MAC table names the LAN port; that beats any inference from switch uplinks.
      for (const mac of macs) {
        const hit = routerPortFor(mac)
        if (hit) {
          behind = { infraId: hit.routerId, name: hit.routerName, devicePort: hit.portName, switchId: null, switchName: null, port: null, portName: null }
          break
        }
      }
      if (uplinkOnly) {
        for (const sighting of sightings) {
          if (now - sighting.seenAt > staleMs) continue
          const sw = switchById.get(sighting.switchId)
          const port = sw?.ports.find((item) => item.number === sighting.port)
          const neighbor = port?.lldp.map((item) => item.deviceId).find((id) => id && !switchById.has(id) && id !== group.infra?.id)
          const infra = neighbor ? store.inventory.devices.find((item) => item.id === neighbor) : undefined
          if (sw && port && infra && (!behind || behind.infraId === infra.id)) {
            behind = { infraId: infra.id, name: infra.name, devicePort: behind?.devicePort ?? null, switchId: sw.id, switchName: sw.name, port: port.number, portName: port.planned?.name || null }
            break
          }
        }
        if (!behind) flags.push(`seen via ${switchById.get(uplinkOnly.switchId)?.name ?? uplinkOnly.switchId} uplink port ${uplinkOnly.port}`)
      }
    }

    const track = trackFor(store, group.id, now)
    let location: DeviceLocation | null = null
    let previousLocation: DeviceLocation | null = null
    if (chosen) {
      const moved = !track.location || track.location.switchId !== chosen.switchId || track.location.port !== chosen.port
      if (moved) {
        if (track.location) track.previousLocation = { ...track.location, until: now }
        track.location = { switchId: chosen.switchId, port: chosen.port, since: now }
        store.markDirty()
      }
      location = describeLocation(switchById, chosen.switchId, chosen.port, chosen.vlanId, track.location!.since, chosen.seenAt)
    }
    if (track.previousLocation)
      previousLocation = describeLocation(
        switchById,
        track.previousLocation.switchId,
        track.previousLocation.port,
        null,
        track.previousLocation.since,
        track.previousLocation.until,
      )

    const primaryIp =
      (group.infra && ips.includes(group.infra.managementIp) ? group.infra.managementIp : null) ??
      ips.find((ip) => store.pings.get(ip)?.alive) ??
      ips[0] ??
      null
    const wireless = macs.map((mac) => store.wirelessClients.get(mac)).find((item) => item && now - item.at <= offlineMs) ?? null
    const vlanBySubnet = primaryIp ? vlanForIp(primaryIp) : null
    // A tagged host (the Pi with eth0.10/20/30/40, a Dante device with VLAN interfaces…) is learned in several
    // VLANs on the same trunk port with one MAC. Each IP explains the sighting in its own subnet's VLAN, so the
    // sighting that matches the primary IP is the device's VLAN — not whichever VLAN the switch listed last.
    if (chosen && vlanBySubnet !== null && chosen.vlanId !== vlanBySubnet) {
      const samePort = sightings.find((entry) => entry.switchId === chosen!.switchId && entry.port === chosen!.port && entry.vlanId === vlanBySubnet && now - entry.seenAt <= staleMs)
      if (samePort) chosen = { ...samePort, seenAt: Math.max(samePort.seenAt, chosen.seenAt) }
    }
    if (chosen && location) location = describeLocation(switchById, chosen.switchId, chosen.port, chosen.vlanId, track.location!.since, chosen.seenAt)
    const vlanByFdb = chosen?.vlanId ?? sightings[0]?.vlanId ?? null
    const vlanId = vlanBySubnet ?? vlanByFdb ?? wireless?.vlanId ?? null
    const vlanSource: DeviceState['vlanSource'] = vlanBySubnet !== null ? 'subnet' : vlanByFdb !== null ? 'fdb' : vlanId !== null ? 'ssid' : null
    const ipVlans = new Set(ips.map(vlanForIp).filter((vlan): vlan is number => vlan !== null))
    // Being learned in any VLAN the device holds an address in is fine — only a VLAN it has no address for is a mismatch.
    if (vlanBySubnet !== null && chosen?.vlanId !== null && chosen?.vlanId !== undefined && chosen.vlanId !== vlanBySubnet && !ipVlans.has(chosen.vlanId))
      flags.push(`IP is in VLAN ${vlanBySubnet} subnet but the switch learned it on VLAN ${chosen.vlanId}`)
    if (ipVlans.size > 1) flags.push(`tagged host with addresses in VLAN ${[...ipVlans].sort((a, b) => a - b).join(', ')}`)

    // Duplicate IP: one IP, several MACs, none of them merged into this device.
    for (const ip of ips) {
      const others = [...(arpByIp.get(ip) ?? [])].filter((mac) => !group.macs.has(mac))
      if (others.length) flags.push(`duplicate IP ${ip} also claimed by ${others.join(', ')}`)
    }
    if (macs.some(isLocallyAdministered) && !group.known && !group.infra) flags.push('randomised (private) MAC address')

    const online = lastConfirmed !== null && now - lastConfirmed <= staleMs
    const macOnly = ips.length === 0
    let status: DeviceState['status']
    if (online) {
      if (location && now - Date.parse(location.since) <= thresholds.relocationWindowSeconds * 1000 && previousLocation)
        status = 'relocating'
      // An AP association is a location too: the device is behind that AP, whose own port is known.
      else status = location || behind || wireless ? 'located' : 'unlocated'
    } else status = lastConfirmed !== null && now - lastConfirmed <= offlineMs ? 'stale' : 'offline'

    // Offline planned devices without any observation stay offline (never "stale").
    if (!lastSeen && group.infra) status = 'offline'
    if (!lastSeen && !group.infra) continue
    // Old MAC-only leftovers just clutter; keep the ones that are current.
    if (macOnly && !online && !group.known) continue

    const hostname = ips.map((ip) => store.dns.get(ip)?.hostname ?? null).find(Boolean) ?? null
    const vendor = vendorForMac(macs[0] ?? null)
    const primaryMac = macs[0] ?? null
    const name =
      group.known?.displayName ||
      group.infra?.name ||
      hostname ||
      wireless?.hostname ||
      (vendor && primaryMac ? `${vendor} ${primaryMac.slice(9)}` : null) ||
      primaryMac ||
      primaryIp ||
      group.id

    track.lastStatus = status
    track.lastOnline = online
    devices.push({
      id: group.id,
      status,
      online,
      name,
      hostname,
      vendor,
      macs,
      primaryMac,
      ips,
      primaryIp,
      vlanId,
      vlanSource,
      location,
      previousLocation,
      behind,
      infraId: group.infra?.id ?? null,
      known: group.known,
      firstSeenAt: new Date(track.firstSeenAt).toISOString(),
      lastSeenAt: new Date(lastSeen ?? track.firstSeenAt).toISOString(),
      lastConfirmedAt: lastConfirmed ? new Date(lastConfirmed).toISOString() : null,
      rttMs,
      sources: [...sources],
      macOnly,
      wireless: wireless
        ? {
            apId: wireless.apId,
            ap: wireless.apName ?? wireless.apMac ?? wireless.apId,
            ssid: wireless.ssid,
            band: wireless.band,
            signal: wireless.signal,
            quality: signalQuality(wireless.signal),
            rateMbps: wireless.rateMbps,
            // Filled in by derive.ts once the APs' own switch ports are known.
            apLocation: null,
          }
        : null,
      flags,
    })
  }

  return devices.sort(sortDevices)
}

/** Rough RSSI buckets as Wi-Fi tools usually show them. */
export function signalQuality(dbm: number | null): SignalQuality | null {
  if (dbm === null) return null
  if (dbm >= -55) return 'excellent'
  if (dbm >= -67) return 'good'
  if (dbm >= -75) return 'fair'
  return 'poor'
}

function lldpLocation(switches: SwitchState[], infraId: string, now: number) {
  for (const sw of switches)
    for (const port of sw.ports)
      if (port.lldp.some((neighbor) => neighbor.deviceId === infraId))
        return { switchId: sw.id, port: port.number, vlanId: null, seenAt: now, uplink: false }
  return null
}

function trackFor(store: Store, id: string, now: number): DeviceTrack {
  let track = store.tracks.get(id)
  if (!track) {
    track = { firstSeenAt: now, location: null, previousLocation: null, lastStatus: null, lastOnline: null }
    store.tracks.set(id, track)
    store.markDirty()
  }
  return track
}

function describeLocation(
  switches: Map<string, SwitchState>,
  switchId: string,
  port: number,
  vlanId: number | null,
  since: number,
  lastSeen: number,
): DeviceLocation {
  const sw = switches.get(switchId)
  const planned = sw?.ports.find((item) => item.number === port)?.planned
  return {
    switchId,
    switchName: sw?.name ?? switchId,
    port,
    portName: planned?.name || null,
    vlanId,
    since: new Date(since).toISOString(),
    lastSeenAt: new Date(lastSeen).toISOString(),
  }
}

const max = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b))

const rank: Record<DeviceState['status'], number> = { relocating: 0, located: 1, unlocated: 2, stale: 3, offline: 4 }
function sortDevices(a: DeviceState, b: DeviceState) {
  // Infrastructure first (by management IP), then favourites, then everything else by status.
  if ((a.infraId !== null) !== (b.infraId !== null)) return a.infraId !== null ? -1 : 1
  if (a.known?.favorite !== b.known?.favorite) return a.known?.favorite ? -1 : 1
  if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status]
  if (a.primaryIp && b.primaryIp) return compareIps(a.primaryIp, b.primaryIp)
  return a.name.localeCompare(b.name)
}

export function compareIps(a: string, b: string) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let index = 0; index < 4; index += 1) {
    const diff = (pa[index] ?? 0) - (pb[index] ?? 0)
    if (diff) return diff
  }
  return 0
}
