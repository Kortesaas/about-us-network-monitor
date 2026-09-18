import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  BackendInfo,
  DeviceState,
  KnownDeviceMeta,
  MonitorEvent,
  MonitorState,
  Problem,
  ScanStatus,
  Settings,
} from '@shared/types'
import type { Inventory } from '../inventory/plan.js'
import { config } from '../config.js'
import { log } from '../logger.js'
import { writeJsonAtomic } from '../settings.js'
import type { RawAccessPoint, RawArp, RawPing, RawRouterTraffic, RawSwitch, RawSysInfo, RawWirelessClient } from './raw.js'
import { emptyRawSwitch } from './raw.js'
import { deriveState } from '../analysis/derive.js'
import { isMonitoredIp } from '../inventory/plan.js'

const logger = log('store')

export type DeviceTrack = {
  firstSeenAt: number
  location: { switchId: string; port: number; since: number } | null
  previousLocation: { switchId: string; port: number; since: number; until: number } | null
  lastStatus: DeviceState['status'] | null
  lastOnline: boolean | null
}

export type InfraUse = { inUse: boolean; source: 'auto' | 'manual'; since: string }

type Persisted = {
  known: KnownDeviceMeta[]
  tracks: Record<string, DeviceTrack>
  problemsSince: Record<string, string>
  portsSeenUp: string[]
  infraUse: Record<string, InfraUse>
  events: MonitorEvent[]
  traffic?: Record<string, TrafficPoint[]>
}

export type TrafficPoint = { t: number; inBps: number; outBps: number }
/** Samples kept per traffic series: 6 h at 30 s, 3 h at 15 s. */
export const TRAFFIC_HISTORY = 720

/**
 * Everything the backend knows, raw and derived. Pollers write raw
 * observations; `publish()` derives the UI state, works out what changed,
 * records events, and tells the SSE channel.
 */
export class Store {
  readonly switches = new Map<string, RawSwitch>()
  readonly pings = new Map<string, RawPing>()
  /** key `${ip}|${mac}` — several MACs per IP are kept on purpose (duplicate IP detection). */
  readonly arp = new Map<string, RawArp>()
  readonly sysInfo = new Map<string, RawSysInfo>()
  readonly routerTraffic = new Map<string, RawRouterTraffic>()
  /** Throughput history per series (`wan`, `router-link`, `vlan:<id>`), newest last. */
  readonly traffic = new Map<string, TrafficPoint[]>()
  readonly dns = new Map<string, { hostname: string | null; at: number }>()
  readonly wirelessClients = new Map<string, RawWirelessClient>()
  readonly accessPoints = new Map<string, RawAccessPoint>()
  readonly known = new Map<string, KnownDeviceMeta>()
  readonly tracks = new Map<string, DeviceTrack>()
  readonly problemsSince = new Map<string, string>()
  /** `${switchId}:${port}` of every port that has ever had link — a down SFP that never had link is not a problem. */
  readonly portsSeenUp = new Set<string>()
  /** Which planned infrastructure is part of the current setup (see InfraState.inUse). */
  readonly infraUse = new Map<string, InfraUse>()
  events: MonitorEvent[] = []
  /** WAN / DNS checks from the Pi: target → result. */
  readonly internet = new Map<string, RawPing>()
  dnsCheck: { host: string; ok: boolean; resolvedTo: string | null; error: string | null; at: number; resolvers: string[] } | null = null
  neighborsAt: number | null = null
  routerArpAt: number | null = null
  omadaAt: number | null = null
  omadaError: string | null = null
  localMacs = new Set<string>()
  notices: string[] = []

  private state: MonitorState | null = null
  private version = 0
  private listeners = new Set<(state: MonitorState, changed: (keyof MonitorState)[]) => void>()
  private eventListeners = new Set<(event: MonitorEvent) => void>()
  private dirty = false
  private scanStatus: () => ScanStatus = () => ({ jobs: [], busy: false, activity: null, lastRequestedAt: null })

  constructor(
    public inventory: Inventory,
    public settings: Settings,
    public backend: BackendInfo,
  ) {
    for (const device of inventory.devices) if (device.type === 'switch') this.switches.set(device.id, emptyRawSwitch(device.id))
    this.load()
  }

  /* ------------------------------------------------------- persistence */

  private file() {
    return resolve(config.dataDir, 'state.json')
  }

  private load() {
    const file = this.file()
    if (!existsSync(file)) return
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<Persisted>
      for (const meta of data.known ?? []) this.known.set(meta.id, meta)
      for (const [id, track] of Object.entries(data.tracks ?? {})) this.tracks.set(id, track)
      for (const [id, since] of Object.entries(data.problemsSince ?? {})) this.problemsSince.set(id, since)
      for (const key of data.portsSeenUp ?? []) this.portsSeenUp.add(key)
      for (const [id, use] of Object.entries(data.infraUse ?? {})) this.infraUse.set(id, use)
      for (const [id, points] of Object.entries(data.traffic ?? {})) this.traffic.set(id, points.slice(-TRAFFIC_HISTORY))
      this.events = (data.events ?? []).slice(-this.settings.thresholds.eventHistory)
      logger.info(`restored ${this.known.size} known devices, ${this.tracks.size} device histories, ${this.events.length} events`)
    } catch (error) {
      logger.warn('could not restore state.json', error)
    }
  }

  save(force = false) {
    if (!this.dirty && !force) return
    const data: Persisted = {
      known: [...this.known.values()],
      tracks: Object.fromEntries(this.tracks),
      problemsSince: Object.fromEntries(this.problemsSince),
      portsSeenUp: [...this.portsSeenUp],
      infraUse: Object.fromEntries(this.infraUse),
      traffic: Object.fromEntries(this.traffic),
      events: this.events.slice(-this.settings.thresholds.eventHistory),
    }
    try {
      writeJsonAtomic(this.file(), data)
      this.dirty = false
    } catch (error) {
      logger.error('could not save state.json', error)
    }
  }

  markDirty() {
    this.dirty = true
  }

  /** Appends one throughput sample unless the series already has one for that moment. */
  recordTraffic(id: string, point: TrafficPoint) {
    const list = this.traffic.get(id) ?? []
    const last = list[list.length - 1]
    if (last && point.t <= last.t) return
    list.push(point)
    if (list.length > TRAFFIC_HISTORY) list.splice(0, list.length - TRAFFIC_HISTORY)
    this.traffic.set(id, list)
    this.dirty = true
  }

  /* ------------------------------------------------------- raw writers */

  rawSwitch(deviceId: string): RawSwitch {
    let raw = this.switches.get(deviceId)
    if (!raw) {
      raw = emptyRawSwitch(deviceId)
      this.switches.set(deviceId, raw)
    }
    return raw
  }

  recordPing(ip: string, alive: boolean, rttMs: number | null, at = Date.now()) {
    const previous = this.pings.get(ip)
    this.pings.set(ip, {
      ip,
      alive,
      rttMs: alive ? rttMs : (previous?.rttMs ?? null),
      at,
      lastAliveAt: alive ? at : (previous?.lastAliveAt ?? null),
    })
  }

  recordArp(entry: RawArp) {
    // WAN-side neighbours of the router can never be confirmed from the Pi; they would only ever show as offline.
    if (!isMonitoredIp(this.inventory, entry.ip)) return
    this.arp.set(`${entry.ip}|${entry.mac}`, entry)
  }

  /** Drops ARP rows the router no longer lists so a re-used IP does not look duplicated forever. */
  pruneArp(source: RawArp['source'], keep: Set<string>, now: number) {
    const maxAge = this.settings.thresholds.offlineAfterSeconds * 1000 * 4
    for (const [key, entry] of this.arp) {
      if (entry.source !== source) continue
      if (!keep.has(key) && now - entry.at > maxAge) this.arp.delete(key)
    }
  }

  /* ------------------------------------------------------------- setup */

  isInUse(infraId: string) {
    return this.infraUse.get(infraId)?.inUse === true
  }

  /** Marks a planned device as part of (or not part of) the current setup. Auto never overrides manual. */
  setInUse(infraId: string, inUse: boolean, source: 'auto' | 'manual'): boolean {
    const current = this.infraUse.get(infraId)
    if (current && current.inUse === inUse) return false
    if (source === 'auto' && current?.source === 'manual') return false
    this.infraUse.set(infraId, { inUse, source, since: new Date().toISOString() })
    this.dirty = true
    const device = this.inventory.devices.find((item) => item.id === infraId)
    if (device)
      this.addEvent({
        kind: 'system',
        severity: 'info',
        message: inUse
          ? source === 'auto'
            ? `${device.name} came online — added to this setup and monitored from now on`
            : `${device.name} marked in use`
          : `${device.name} marked not in use — no longer monitored`,
        subject: { type: 'infra', id: device.id, label: device.name, href: device.type === 'switch' ? `/switches/${device.id}` : '/overview' },
      })
    return true
  }

  /** New show: forget which devices/trunks were used last time. Manual choices and device metadata stay. */
  resetSetup() {
    for (const [id, use] of this.infraUse) if (use.source === 'auto') this.infraUse.delete(id)
    this.portsSeenUp.clear()
    this.problemsSince.clear()
    this.dirty = true
    this.addEvent({ kind: 'system', severity: 'info', message: 'New setup started — learned devices and trunks reset', subject: null })
  }

  /** Resolves a current show-state problem when the operator confirms it was intentional. */
  resolveProblem(problemId: string): { ok: true; message: string } | { ok: false; status: number; error: string } {
    const problem = this.current().problems.find((item) => item.id === problemId)
    if (!problem) return { ok: false, status: 404, error: 'problem is not active' }
    if (problem.code !== 'uplink-down' && problem.code !== 'ap-port-down')
      return { ok: false, status: 400, error: 'this problem cannot be resolved manually yet' }
    if (problem.subject.type !== 'port') return { ok: false, status: 400, error: 'problem is not tied to a switch port' }

    this.portsSeenUp.delete(problem.subject.id)
    this.problemsSince.delete(problem.id)
    this.dirty = true
    this.addEvent({
      kind: 'problem-cleared',
      severity: 'ok',
      message: `Resolved: ${problem.title}`,
      subject: problem.subject,
    })
    this.publish()
    return { ok: true, message: 'problem resolved for this setup' }
  }

  /* ------------------------------------------------------------- known */

  upsertKnown(meta: KnownDeviceMeta) {
    this.known.set(meta.id, meta)
    this.dirty = true
  }

  deleteKnown(id: string) {
    this.known.delete(id)
    this.dirty = true
  }

  /* ------------------------------------------------------------ events */

  addEvent(event: Omit<MonitorEvent, 'id' | 'at'> & { at?: string }): MonitorEvent {
    const full: MonitorEvent = { id: randomUUID(), at: event.at ?? new Date().toISOString(), ...event }
    this.events.push(full)
    if (this.events.length > this.settings.thresholds.eventHistory)
      this.events.splice(0, this.events.length - this.settings.thresholds.eventHistory)
    this.dirty = true
    for (const listener of this.eventListeners) listener(full)
    return full
  }

  onEvent(listener: (event: MonitorEvent) => void) {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  /* ----------------------------------------------------------- publish */

  attachScanStatus(provider: () => ScanStatus) {
    this.scanStatus = provider
  }

  scan(): ScanStatus {
    return this.scanStatus()
  }

  onChange(listener: (state: MonitorState, changed: (keyof MonitorState)[]) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  current(): MonitorState {
    if (!this.state) this.publish()
    return this.state!
  }

  /** Re-derives the UI state from the raw observations and announces what changed. */
  publish() {
    const previous = this.state
    const now = Date.now()
    for (const raw of this.switches.values())
      for (const [ifIndex, iface] of raw.interfaces) {
        const port = raw.portMap.get(ifIndex)
        if (port !== undefined && iface.operUp && !this.portsSeenUp.has(`${raw.deviceId}:${port}`)) {
          this.portsSeenUp.add(`${raw.deviceId}:${port}`)
          this.dirty = true
        }
      }
    const derived = deriveState(this, now)
    this.recordTransitions(previous, derived, now)
    this.version += 1
    const next: MonitorState = {
      ...derived,
      version: this.version,
      generatedAt: new Date(now).toISOString(),
      backend: { ...this.backend, notices: this.notices },
      scan: this.scanStatus(),
      events: [...this.events].reverse().slice(0, 200),
    }
    const changed = previous ? diffKeys(previous, next) : (Object.keys(next) as (keyof MonitorState)[])
    this.state = next
    for (const listener of this.listeners) listener(next, changed)
  }

  /** Turns state deltas into the event timeline the user reads during a show. */
  private recordTransitions(previous: MonitorState | null, next: ReturnType<typeof deriveState>, now: number) {
    const at = new Date(now).toISOString()
    // Problems: raised / cleared.
    const seen = new Set<string>()
    for (const problem of next.problems) {
      seen.add(problem.id)
      if (!this.problemsSince.has(problem.id)) {
        this.problemsSince.set(problem.id, at)
        this.dirty = true
        if (previous)
          this.addEvent({
            at,
            kind: 'problem-raised',
            severity: problem.severity,
            message: problem.title,
            subject: problem.subject,
          })
      }
    }
    for (const [id] of this.problemsSince) {
      if (seen.has(id)) continue
      this.problemsSince.delete(id)
      this.dirty = true
      const before = previous?.problems.find((problem) => problem.id === id)
      if (before)
        this.addEvent({ at, kind: 'problem-cleared', severity: 'ok', message: `Cleared: ${before.title}`, subject: before.subject })
    }
    if (!previous) return
    // Devices: appeared / online / offline / moved.
    const before = new Map(previous.devices.map((device) => [device.id, device]))
    for (const device of next.devices) {
      if (device.macOnly || device.known?.ignored) continue
      const old = before.get(device.id)
      const subject = { type: 'device', id: device.id, label: device.name, href: `/devices/${encodeURIComponent(device.id)}` }
      if (!old) {
        // After a restart every device is "new" to the previous state but not to the operator.
        if (device.online && now - Date.parse(device.firstSeenAt) < 120_000)
          this.addEvent({ at, kind: 'device-new', severity: 'info', message: `New device ${describe(device)}`, subject })
        continue
      }
      if (old.online !== device.online)
        this.addEvent({
          at,
          kind: device.online ? 'device-online' : 'device-offline',
          severity: device.online ? 'ok' : device.known?.favorite || device.infraId ? 'warning' : 'info',
          message: `${device.name} is ${device.online ? (old.lastConfirmedAt ? 'back online' : 'online') : 'offline'}`,
          subject,
        })
      // `since` is only reset when the location actually changed, so a restart does not replay old moves.
      const recentlyPlaced = device.location !== null && now - Date.parse(device.location.since) < 30_000
      const moved =
        recentlyPlaced &&
        old.location &&
        device.location &&
        (old.location.switchId !== device.location.switchId || old.location.port !== device.location.port)
      if (moved)
        this.addEvent({
          at,
          kind: 'device-moved',
          severity: 'info',
          message: `${device.name} moved from ${old.location!.switchName} port ${old.location!.port} to ${device.location!.switchName} port ${device.location!.port}`,
          subject,
        })
      else if (recentlyPlaced && !old.location && device.location)
        this.addEvent({
          at,
          kind: 'device-moved',
          severity: 'ok',
          message: `${device.name} located on ${device.location.switchName} port ${device.location.port}`,
          subject,
        })
      // Wi-Fi: roamed to another AP, or joined/left the WLAN while staying online (a wired device would show as moved).
      if (old.wireless && device.wireless && old.wireless.apId !== device.wireless.apId)
        this.addEvent({ at, kind: 'device-roamed', severity: 'info', message: `${device.name} roamed from ${old.wireless.ap} to ${device.wireless.ap}${device.wireless.ssid ? ` (${device.wireless.ssid})` : ''}`, subject })
      else if (!old.wireless && device.wireless && old.online && device.online)
        this.addEvent({ at, kind: 'device-roamed', severity: 'info', message: `${device.name} joined Wi-Fi on ${device.wireless.ap}${device.wireless.ssid ? ` (${device.wireless.ssid})` : ''}`, subject })
    }
    // Infra reachability.
    const infraBefore = new Map(previous.infra.map((item) => [item.id, item]))
    for (const item of next.infra) {
      const old = infraBefore.get(item.id)
      if (!old || old.reachability === item.reachability || old.reachability === 'unknown') continue
      const online = item.reachability === 'online'
      if (online || item.reachability === 'offline')
        this.addEvent({
          at,
          kind: online ? 'infra-online' : 'infra-offline',
          severity: online ? 'ok' : 'critical',
          message: `${item.name} (${item.managementIp}) is ${online ? 'reachable again' : 'unreachable'}`,
          subject: { type: 'infra', id: item.id, label: item.name, href: item.type === 'switch' ? `/switches/${item.id}` : '/overview' },
        })
    }
    // Port link changes.
    const portsBefore = new Map<string, boolean>()
    for (const sw of previous.switches) for (const port of sw.ports) if (port.link) portsBefore.set(`${sw.id}:${port.number}`, port.link.operUp)
    for (const sw of next.switches)
      for (const port of sw.ports) {
        if (!port.link) continue
        const old = portsBefore.get(`${sw.id}:${port.number}`)
        if (old === undefined || old === port.link.operUp) continue
        const label = port.planned?.name ? ` (${port.planned.name})` : ''
        this.addEvent({
          at,
          kind: port.link.operUp ? 'port-up' : 'port-down',
          severity: port.link.operUp ? 'ok' : port.uplink || port.planned?.mode === 'trunk' ? 'warning' : 'info',
          message: `${sw.name} port ${port.number}${label} link ${port.link.operUp ? 'up' : 'down'}`,
          subject: { type: 'port', id: `${sw.id}:${port.number}`, label: `${sw.name} · ${port.number}`, href: `/switches/${sw.id}?port=${port.number}` },
        })
      }
  }
}

const describe = (device: DeviceState) =>
  [device.name, device.primaryIp, device.vlanId !== null ? `VLAN ${device.vlanId}` : null].filter(Boolean).join(' · ')

function diffKeys(a: MonitorState, b: MonitorState): (keyof MonitorState)[] {
  const keys: (keyof MonitorState)[] = ['summary', 'internet', 'vlans', 'infra', 'switches', 'devices', 'topology', 'problems', 'events']
  return keys.filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
}

export type { Problem }
