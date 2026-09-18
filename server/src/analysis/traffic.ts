import type { InfraState, SwitchState, TrafficSeries, TrafficState, VlanState } from '@shared/types'
import { TRAFFIC_HISTORY, type Store } from '../state/store.js'

/** Samples shipped inside `/api/state`; the full ring buffer is served by `/api/traffic`. */
const RECENT_SAMPLES = 60

/**
 * Throughput series from what the network can actually measure:
 *  - `wan`         the router's WAN interface counters — real internet usage
 *  - `router-link` switch ports facing the router — everything routed (internet + inter-VLAN)
 *  - `vlan:<id>`   the sum over access ports in that VLAN — what the devices in it send/receive
 * Trunk ports carry several VLANs and are never attributed to one of them.
 */
export function buildTraffic(store: Store, switches: SwitchState[], infra: InfraState[], vlans: VlanState[], now: number): TrafficState {
  const inUse = new Set(infra.filter((item) => item.inUse).map((item) => item.id))
  const routerIds = new Set(infra.filter((item) => item.inUse && item.type === 'router').map((item) => item.id))
  const series: TrafficSeries[] = []

  /* ---- WAN: the router's own counters ---- */
  let wan: TrafficState['wan'] = null
  for (const [routerId, raw] of store.routerTraffic) {
    if (!inUse.has(routerId)) continue
    const router = infra.find((item) => item.id === routerId)
    const wanIfaces = raw.interfaces.filter((iface) => iface.wan)
    const measured = wanIfaces.filter((iface) => iface.inBps !== null && iface.outBps !== null)
    const inBps = measured.length ? measured.reduce((sum, iface) => sum + (iface.inBps ?? 0), 0) : null
    const outBps = measured.length ? measured.reduce((sum, iface) => sum + (iface.outBps ?? 0), 0) : null
    wan = {
      routerId,
      routerName: router?.name ?? routerId,
      interfaces: wanIfaces.map((iface) => ({ name: iface.name, up: iface.operUp, inBps: iface.inBps, outBps: iface.outBps })),
      inBps,
      outBps,
      at: new Date(raw.at).toISOString(),
      error: raw.lastError ?? (wanIfaces.length === 0 ? 'no WAN interface found on the router (set the name under Settings → Discovery)' : null),
    }
    if (inBps !== null && outBps !== null && raw.lastOkAt) store.recordTraffic('wan', { t: raw.lastOkAt, inBps, outBps })
    series.push({ ...makeSeries(store, 'wan', 'wan', 'Internet', 'download', 'upload', null, null, inBps, outBps), source: wan.interfaces.map((iface) => iface.name).join(', ') || null })
    break
  }

  /* ---- router link: the router's own LAN ports when it reports them (catches APs hanging off the router), else the switch ports facing it ---- */
  let linkIn = 0
  let linkOut = 0
  let linkAt: number | null = null
  let linkSeen = false
  let linkSource: string | null = null
  for (const [routerId, raw] of store.routerTraffic) {
    if (!inUse.has(routerId)) continue
    const lan = raw.interfaces.filter((iface) => !iface.wan && iface.operUp && iface.inBps !== null && iface.outBps !== null)
    if (!lan.length) continue
    linkSeen = true
    linkSource = `${infra.find((item) => item.id === routerId)?.name ?? 'router'} ${lan.map((iface) => iface.name).join(', ')}`
    // Router "out" leaves towards the LAN → download for the LAN; "in" is what the LAN sends up.
    for (const iface of lan) {
      linkIn += iface.outBps ?? 0
      linkOut += iface.inBps ?? 0
    }
    linkAt = raw.lastOkAt
    break
  }
  const perVlan = new Map<number, { inBps: number; outBps: number; at: number; ports: number }>()
  let measuring = false
  let latestSample: number | null = null
  for (const sw of switches) {
    if (!inUse.has(sw.id) || !sw.snmp.ok) continue
    measuring = true
    for (const port of sw.ports) {
      if (!port.rates || !port.link?.operUp) continue
      const sampledAt = port.counters ? Date.parse(port.counters.sampledAt) : now
      latestSample = Math.max(latestSample ?? 0, sampledAt)
      if (port.lldp.some((neighbor) => neighbor.deviceId && routerIds.has(neighbor.deviceId))) {
        if (linkSource === null) {
          linkSeen = true
          // From the switch's point of view "in" arrives from the router → that is the LAN's download.
          linkIn += port.rates.inBps
          linkOut += port.rates.outBps
          linkAt = Math.max(linkAt ?? 0, sampledAt)
        }
        continue
      }
      const vlanId = accessVlanOf(port)
      if (vlanId === null) continue
      const entry = perVlan.get(vlanId) ?? { inBps: 0, outBps: 0, at: 0, ports: 0 }
      entry.ports += 1
      // Port "out" is what the switch sends to the device (its download), "in" what the device sends.
      entry.inBps += port.rates.outBps
      entry.outBps += port.rates.inBps
      entry.at = Math.max(entry.at, sampledAt)
      perVlan.set(vlanId, entry)
    }
  }
  if (linkSeen && linkAt) {
    store.recordTraffic('router-link', { t: linkAt, inBps: linkIn, outBps: linkOut })
    series.push({ ...makeSeries(store, 'router-link', 'router-link', 'Router link', 'from router', 'to router', null, null, linkIn, linkOut), source: linkSource ?? 'switch ports facing the router' })
  }
  // Wi-Fi: the APs report each client's throughput and the VLAN its SSID maps to — independent of where the AP is plugged in.
  const wifiPerVlan = new Map<number, { inBps: number; outBps: number; at: number; clients: number }>()
  const offlineMs = store.settings.thresholds.offlineAfterSeconds * 1000
  for (const client of store.wirelessClients.values()) {
    if (now - client.at > offlineMs || client.vlanId === null) continue
    const entry = wifiPerVlan.get(client.vlanId) ?? { inBps: 0, outBps: 0, at: 0, clients: 0 }
    entry.clients += 1
    entry.inBps += client.rxBps ?? 0
    entry.outBps += client.txBps ?? 0
    entry.at = Math.max(entry.at, client.at)
    wifiPerVlan.set(client.vlanId, entry)
  }
  // Every planned VLAN is listed as soon as any switch delivers counters; a VLAN without an active access port is a flat zero, not a missing chart.
  for (const vlan of vlans) {
    if (!vlan.planned) continue
    const wired = perVlan.get(vlan.vlanId) ?? (measuring && latestSample ? { inBps: 0, outBps: 0, at: latestSample, ports: 0 } : null)
    const wifi = wifiPerVlan.get(vlan.vlanId) ?? null
    const entry =
      wired || wifi
        ? { inBps: (wired?.inBps ?? 0) + (wifi?.inBps ?? 0), outBps: (wired?.outBps ?? 0) + (wifi?.outBps ?? 0), at: Math.max(wired?.at ?? 0, wifi?.at ?? 0), ports: wired?.ports ?? 0, clients: wifi?.clients ?? 0 }
        : null
    if (entry) store.recordTraffic(`vlan:${vlan.vlanId}`, { t: entry.at, inBps: entry.inBps, outBps: entry.outBps })
    if (!entry && !store.traffic.has(`vlan:${vlan.vlanId}`)) continue
    series.push({
      ...makeSeries(store, `vlan:${vlan.vlanId}`, 'vlan', `${vlan.vlanId} ${vlan.name}`, 'to devices', 'from devices', vlan.vlanId, vlan.color, entry?.inBps ?? null, entry?.outBps ?? null),
      activePorts: wired ? wired.ports : null,
      wifiClients: entry ? entry.clients : null,
      source: 'access ports + Wi-Fi clients',
    })
  }

  return {
    wan,
    series,
    wanIntervalSeconds: store.settings.polling.routerTrafficSeconds,
    historySeconds: TRAFFIC_HISTORY * Math.min(store.settings.polling.routerTrafficSeconds, store.settings.polling.snmpFastSeconds),
  }
}

/** The VLAN an access port belongs to: live PVID when the switch told us, else the plan. */
function accessVlanOf(port: SwitchState['ports'][number]): number | null {
  if (port.uplink) return null
  if (port.discovered && port.discovered.mode !== 'unknown') return port.discovered.mode === 'access' ? port.discovered.pvid : null
  if (port.planned?.mode === 'access') return port.planned.accessVlanId ?? port.planned.nativeVlanId
  return null
}

function makeSeries(store: Store, id: string, kind: TrafficSeries['kind'], label: string, inLabel: string, outLabel: string, vlanId: number | null, color: string | null, inBps: number | null, outBps: number | null): TrafficSeries {
  return {
    id,
    kind,
    label,
    inLabel,
    outLabel,
    vlanId,
    color,
    inBps,
    outBps,
    activePorts: null,
    wifiClients: null,
    source: null,
    samples: (store.traffic.get(id) ?? []).slice(-RECENT_SAMPLES).map((point) => ({ t: new Date(point.t).toISOString(), inBps: point.inBps, outBps: point.outBps })),
  }
}

/** Full history for the Traffic page. */
export function trafficHistory(store: Store, traffic: TrafficState): TrafficSeries[] {
  return traffic.series.map((item) => ({
    ...item,
    samples: (store.traffic.get(item.id) ?? []).map((point) => ({ t: new Date(point.t).toISOString(), inBps: point.inBps, outBps: point.outBps })),
  }))
}
