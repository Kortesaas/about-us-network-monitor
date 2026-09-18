import type { DeviceState, InfraState, WlanAccessPoint, WlanClient, WlanSsidSummary, WlanState } from '@shared/types'
import type { Store } from '../state/store.js'
import type { RawAccessPoint, RawWirelessClient } from '../state/raw.js'
import { signalQuality } from './devices.js'

/**
 * Access points, their radios/SSIDs and the Wi-Fi clients behind them. Planned
 * APs are always listed (with poll status) so a missing password or a locked
 * login is visible; APs only known from an Omada controller are appended.
 */
export function buildWlan(store: Store, infra: InfraState[], devices: DeviceState[], now: number): WlanState {
  const offlineMs = store.settings.thresholds.offlineAfterSeconds * 1000
  const { accessPoints: apSettings, omada } = store.settings
  const configured = (apSettings.enabled && apSettings.password.length > 0) || omada.enabled
  const infraById = new Map(infra.map((item) => [item.id, item]))
  const deviceByMac = new Map<string, DeviceState>()
  for (const device of devices) for (const mac of device.macs) deviceByMac.set(mac, device)

  const clientsByAp = new Map<string, WlanClient[]>()
  const toClient = (raw: RawWirelessClient, apName: string): WlanClient => {
    const device = deviceByMac.get(raw.mac) ?? null
    return {
      mac: raw.mac,
      deviceId: device?.id ?? null,
      name: device?.name ?? raw.hostname ?? raw.mac,
      hostname: raw.hostname ?? device?.hostname ?? null,
      ip: raw.ip ?? device?.primaryIp ?? null,
      vlanId: device?.vlanId ?? raw.vlanId,
      apId: raw.apId,
      apName,
      ssid: raw.ssid,
      radioId: raw.radioId,
      band: raw.band,
      signal: raw.signal,
      quality: signalQuality(raw.signal),
      rateMbps: raw.rateMbps,
      connectedSeconds: raw.connectedSeconds,
      rxBytes: raw.rxBytes,
      txBytes: raw.txBytes,
      rxBps: raw.rxBps,
      txBps: raw.txBps,
      lastSeenAt: new Date(raw.at).toISOString(),
    }
  }
  const apName = (id: string) => store.accessPoints.get(id)?.name ?? infraById.get(id)?.name ?? id
  for (const raw of store.wirelessClients.values()) {
    if (now - raw.at > offlineMs) continue
    const list = clientsByAp.get(raw.apId) ?? []
    list.push(toClient(raw, raw.apName ?? apName(raw.apId)))
    clientsByAp.set(raw.apId, list)
  }
  const sortClients = (list: WlanClient[]) => list.sort((a, b) => (b.signal ?? -999) - (a.signal ?? -999) || a.name.localeCompare(b.name))

  const toAccessPoint = (planned: InfraState | null, raw: RawAccessPoint | null): WlanAccessPoint => {
    const id = planned?.id ?? raw!.id
    const clients = sortClients(clientsByAp.get(id) ?? [])
    const eapApplies = planned !== null && apSettings.enabled && apSettings.password.length > 0 && planned.inUse
    return {
      id,
      name: planned?.name ?? raw?.name ?? id,
      model: planned?.model || raw?.model || null,
      manufacturer: planned?.manufacturer?.trim() || null,
      ip: planned?.managementIp ?? raw?.ip ?? null,
      mac: raw?.mac ?? planned?.mac ?? null,
      firmware: raw?.firmware ?? null,
      hardware: raw?.hardware ?? null,
      inUse: planned ? planned.inUse : true,
      reachability: planned ? planned.reachability : raw?.status === 'online' ? 'online' : raw?.status === 'offline' ? 'offline' : 'unknown',
      uptimeSeconds: raw?.uptimeSeconds ?? planned?.uptimeSeconds ?? null,
      cpuPercent: raw?.cpuPercent ?? null,
      memoryPercent: raw?.memoryPercent ?? null,
      lanLink: raw?.lanLink ?? null,
      source: raw?.source ?? (eapApplies ? 'eap' : null),
      poll:
        raw || eapApplies
          ? {
              ok: raw !== null && raw.lastError === null && raw.lastOkAt !== null,
              at: raw ? new Date(raw.at).toISOString() : null,
              lastOkAt: raw?.lastOkAt ? new Date(raw.lastOkAt).toISOString() : null,
              error: raw?.lastError ?? (raw ? null : 'not polled yet'),
              durationMs: raw?.lastDurationMs ?? null,
            }
          : null,
      locatedAt: planned?.locatedAt ?? null,
      attachedTo: (() => {
        const behind = planned ? devices.find((device) => device.infraId === planned.id)?.behind : null
        return behind ? `${behind.name}${behind.devicePort ? ` · ${behind.devicePort}` : ''}` : null
      })(),
      radios: (raw?.radios ?? []).map((radio) => ({
        ...radio,
        clients: clients.filter((client) => client.radioId === radio.id).length,
      })),
      ssids: (raw?.ssids ?? []).map((ssid) => ({
        ...ssid,
        band: raw?.radios.find((radio) => radio.id === ssid.radioId)?.band ?? `radio ${ssid.radioId}`,
      })),
      clients,
    }
  }

  const accessPoints: WlanAccessPoint[] = []
  const covered = new Set<string>()
  for (const planned of infra) {
    if (planned.type !== 'access-point') continue
    // Standalone polls are keyed by the planned id; controller polls by MAC.
    const raw =
      store.accessPoints.get(planned.id) ?? (planned.mac ? store.accessPoints.get(planned.mac) : undefined) ?? [...store.accessPoints.values()].find((item) => item.ip === planned.managementIp) ?? null
    if (raw) covered.add(raw.id)
    accessPoints.push(toAccessPoint(planned, raw))
  }
  for (const raw of store.accessPoints.values()) if (!covered.has(raw.id)) accessPoints.push(toAccessPoint(null, raw))
  accessPoints.sort((a, b) => Number(b.inUse) - Number(a.inUse) || a.name.localeCompare(b.name))

  const ssidMap = new Map<string, WlanSsidSummary>()
  for (const ap of accessPoints)
    for (const ssid of ap.ssids) {
      const entry = ssidMap.get(ssid.ssid) ?? {
        ssid: ssid.ssid,
        vlanId: ssid.vlanId,
        apIds: [],
        bands: [],
        clients: 0,
      }
      if (entry.vlanId === null) entry.vlanId = ssid.vlanId
      if (!entry.apIds.includes(ap.id)) entry.apIds.push(ap.id)
      if (!entry.bands.includes(ssid.band)) entry.bands.push(ssid.band)
      ssidMap.set(ssid.ssid, entry)
    }
  const clients = sortClients(accessPoints.flatMap((ap) => ap.clients))
  for (const client of clients) {
    if (!client.ssid) continue
    const entry = ssidMap.get(client.ssid) ?? {
      ssid: client.ssid,
      vlanId: client.vlanId,
      apIds: [],
      bands: [],
      clients: 0,
    }
    entry.clients += 1
    ssidMap.set(client.ssid, entry)
  }

  return {
    accessPoints,
    ssids: [...ssidMap.values()].sort((a, b) => b.clients - a.clients || a.ssid.localeCompare(b.ssid)),
    clients,
    configured,
  }
}
