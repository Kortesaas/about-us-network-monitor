import type { PlannedDevice, ScanScope, Settings } from '@shared/types'
import { cidrContains, cidrHosts, parseCidr } from '@shared/ip'
import { isUnicastMac } from '@shared/mac'
import type { Store } from '../state/store.js'
import type { RawSysInfo } from '../state/raw.js'
import { Scheduler } from './scheduler.js'
import type { SnmpSession, SnmpSessionOptions, Transports } from './transport.js'
import { pollSwitchConfig, pollSwitchFast, pollSwitchTables } from './snmp/switchPoller.js'
import { pollRouterArp, pollRouterTraffic, pollSysInfo } from './snmp/routerPoller.js'
import { pollOmada } from './omada.js'
import { EapPoller } from './eap.js'
import { isMonitoredIp } from '../inventory/plan.js'
import { log } from '../logger.js'

const logger = log('poll')

/** Community for a planned device: explicit target first, then the per-vendor default. */
export function resolveSnmp(settings: Settings, device: PlannedDevice): SnmpSessionOptions | null {
  if (!device.managementIp) return null
  const target = settings.snmp.targets.find((item) => item.deviceId === device.id)
  if (target) {
    if (!target.enabled || !target.community) return null
    return { host: device.managementIp, community: target.community, version: target.version, port: target.port, timeoutMs: settings.snmp.timeoutMs, retries: settings.snmp.retries }
  }
  const vendor = device.manufacturer.toLowerCase()
  const key = Object.keys(settings.snmp.defaultCommunities).find((name) => vendor.includes(name.toLowerCase()))
  const community = key ? settings.snmp.defaultCommunities[key] : undefined
  if (!community) return null
  return { host: device.managementIp, community, version: '2c', port: 161, timeoutMs: settings.snmp.timeoutMs, retries: settings.snmp.retries }
}

export class Poller {
  readonly scheduler = new Scheduler()
  private publishTimer: NodeJS.Timeout | null = null
  private readonly eap: EapPoller

  constructor(
    private readonly store: Store,
    private readonly transports: Transports,
  ) {
    this.eap = new EapPoller(transports.http)
    this.scheduler.onChange(() => this.schedulePublish(150))
  }

  start() {
    this.configure()
    this.scheduler.start()
  }

  stop() {
    this.scheduler.stop()
    if (this.publishTimer) clearTimeout(this.publishTimer)
  }

  /** (Re)builds the job list from the current settings and inventory. Safe to call again after a settings change. */
  configure() {
    const { settings, inventory } = this.store
    const scheduler = this.scheduler
    scheduler.setPoolLimit('snmp', settings.polling.snmpConcurrency)
    scheduler.setPoolLimit('sweep', 1)
    scheduler.setPoolLimit('eap', 2)
    // New credentials or timeouts apply at once; a login back-off ends when the user fixes the password.
    this.eap.reset()
    if (!settings.accessPoints.enabled) {
      for (const [id, ap] of this.store.accessPoints) if (ap.source === 'eap') this.store.accessPoints.delete(id)
      for (const [mac, client] of this.store.wirelessClients) if (client.source === 'eap') this.store.wirelessClients.delete(mac)
    }
    const wanted = new Set<string>()
    const upsert = (id: string, label: string, intervalMs: number, pool: string | undefined, run: () => Promise<void>, delay: number) => {
      wanted.add(id)
      if (scheduler.has(id)) scheduler.setInterval(id, intervalMs)
      else scheduler.add({ id, label, intervalMs, minGapMs: settings.polling.minGapSeconds * 1000, pool, run }, delay)
    }
    const s = settings.polling
    let delay = 0
    const next = () => (delay += 400)

    upsert('infra-ping', 'Ping infrastructure', s.infraPingSeconds * 1000, undefined, () => this.pingInfra(), next())
    if (settings.discovery.localNeighbors && this.transports.neighbors.available)
      upsert('neighbors', 'Read local neighbour table', s.neighborSeconds * 1000, undefined, () => this.readNeighbors(), next())

    for (const device of inventory.devices) {
      if (!isMonitoredIp(this.store.inventory, device.managementIp)) continue
      if (device.type === 'switch') {
        const label = device.name
        upsert(`switch-config:${device.id}`, `${label}: VLAN config`, s.snmpConfigSeconds * 1000, 'snmp', () => this.withSnmp(device, (session) => pollSwitchConfig(session, this.store.rawSwitch(device.id), device)), next())
        upsert(`switch-fast:${device.id}`, `${label}: ports & counters`, s.snmpFastSeconds * 1000, 'snmp', () => this.withSnmp(device, (session) => pollSwitchFast(session, this.store.rawSwitch(device.id), device)), next())
        upsert(`switch-tables:${device.id}`, `${label}: MAC & LLDP tables`, s.snmpTablesSeconds * 1000, 'snmp', () => this.withSnmp(device, (session) => pollSwitchTables(session, this.store.rawSwitch(device.id), device)), next())
      } else if (device.type === 'router' && isMonitoredIp(this.store.inventory, device.managementIp)) {
        upsert(`sysinfo:${device.id}`, `${device.name}: system info`, s.snmpConfigSeconds * 1000, 'snmp', () => this.sysInfo(device), next())
        if (settings.discovery.routerArp)
          upsert(`router-arp:${device.id}`, `${device.name}: ARP table`, s.routerArpSeconds * 1000, 'snmp', () => this.routerArp(device), next())
        upsert(`router-traffic:${device.id}`, `${device.name}: WAN throughput`, s.routerTrafficSeconds * 1000, 'snmp', () => this.routerTraffic(device), next())
      } else if (device.type === 'access-point') {
        // Standalone Omada EAPs: clients, SSIDs and radios through the AP's own web API.
        if (settings.accessPoints.enabled && settings.accessPoints.password)
          upsert(`ap:${device.id}`, `${device.name}: Wi-Fi clients`, settings.accessPoints.intervalSeconds * 1000, 'eap', () => this.accessPoint(device), next())
        // Their SNMP agent only has MIB-II; poll it only when the user explicitly configured a community.
        if (settings.snmp.targets.some((target) => target.deviceId === device.id && target.enabled))
          upsert(`sysinfo:${device.id}`, `${device.name}: system info`, s.snmpConfigSeconds * 1000, 'snmp', () => this.sysInfo(device), next())
      }
    }

    if (settings.discovery.sweepEnabled && this.transports.ping.tool !== 'none')
      for (const cidr of this.sweepTargets())
        upsert(`sweep:${cidr}`, `Sweep ${cidr}`, s.sweepSeconds * 1000, 'sweep', () => this.sweep(cidr), (delay += 3000))

    // Runs often but only resolves addresses whose cached answer is older than dnsSeconds.
    if (settings.discovery.reverseDns) upsert('dns', 'Reverse DNS', 30_000, undefined, () => this.reverseDns(), next())
    if (settings.internet.enabled && this.transports.ping.tool !== 'none')
      upsert('internet', 'Internet & DNS check', settings.internet.intervalSeconds * 1000, undefined, () => this.internetCheck(), next())
    if (settings.omada.enabled) upsert('omada', 'Omada controller', settings.omada.intervalSeconds * 1000, undefined, () => this.omada(), next())
    upsert('persist', 'Save state', 60_000, undefined, async () => this.store.save(), 60_000)

    for (const job of scheduler.status().jobs) if (!wanted.has(job.id)) scheduler.remove(job.id)
  }

  /** Manual refresh: queue the relevant jobs; the scheduler still enforces cooldowns. */
  request(scope: ScanScope): string[] {
    const ids = this.scheduler.request((id) => {
      if (scope === 'all') return id !== 'persist'
      if (scope === 'infra') return id === 'infra-ping' || id === 'neighbors' || id.startsWith('sysinfo:') || id.startsWith('ap:') || id.startsWith('router-traffic:')
      if (scope === 'wlan') return id.startsWith('ap:')
      if (scope === 'switches') return id.startsWith('switch-')
      if (scope === 'sweep') return id.startsWith('sweep:') || id.startsWith('router-arp:') || id === 'neighbors'
      if (scope === 'neighbors') return id === 'neighbors' || id.startsWith('router-arp:')
      if (scope.startsWith('switch:')) return id.startsWith('switch-') && id.endsWith(`:${scope.slice(7)}`)
      return false
    })
    this.store.addEvent({ kind: 'scan', severity: 'info', message: `Refresh requested (${scope}): ${ids.length} job${ids.length === 1 ? '' : 's'} queued`, subject: null })
    return ids
  }

  private schedulePublish(delayMs: number) {
    if (this.publishTimer) return
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null
      try {
        this.store.publish()
      } catch (error) {
        logger.error('publish failed', error)
      }
    }, delayMs)
  }

  /* ------------------------------------------------------------ jobs */

  private sweepTargets(): string[] {
    const { discovery } = this.store.settings
    const excluded = discovery.excludeCidrs.map(parseCidr).filter(Boolean)
    const planned = this.store.inventory.subnets.map((subnet) => subnet.cidr)
    const list = discovery.sweepCidrs.length ? discovery.sweepCidrs : planned
    return list.filter((cidr) => {
      const parsed = parseCidr(cidr)
      if (!parsed || parsed.bits < 22) return false
      return !excluded.some((item) => item && item.cidr === parsed.cidr)
    })
  }

  private async pingInfra() {
    const { inventory, settings } = this.store
    const ips = new Set<string>()
    for (const device of inventory.devices) if (device.managementIp && isMonitoredIp(this.store.inventory, device.managementIp)) ips.add(device.managementIp)
    for (const subnet of inventory.subnets) if (subnet.gateway) ips.add(subnet.gateway)
    for (const known of this.store.known.values()) if (known.favorite) for (const ip of known.ips) ips.add(ip)
    // Favourites identified by MAC: ping the IP we last saw for them.
    const favoriteMacs = new Set([...this.store.known.values()].filter((item) => item.favorite).flatMap((item) => item.macs))
    for (const entry of this.store.arp.values()) if (favoriteMacs.has(entry.mac)) ips.add(entry.ip)
    const results = await this.transports.ping.ping([...ips], { timeoutMs: Math.min(1500, settings.snmp.timeoutMs) })
    const now = Date.now()
    for (const result of results) this.store.recordPing(result.ip, result.alive, result.rttMs, now)
    // A planned device that answers for the first time joins the setup automatically — and stays in it.
    const alive = new Set(results.filter((result) => result.alive).map((result) => result.ip))
    for (const device of inventory.devices)
      if (device.managementIp && alive.has(device.managementIp) && !this.store.isInUse(device.id))
        if (this.store.setInUse(device.id, true, 'auto')) this.scheduler.request((id) => id.endsWith(`:${device.id}`))
  }

  private async readNeighbors() {
    const entries = await this.transports.neighbors.read()
    const now = Date.now()
    const keep = new Set<string>()
    for (const entry of entries) {
      if (!isUnicastMac(entry.mac)) continue
      keep.add(`${entry.ip}|${entry.mac}`)
      this.store.recordArp({ ip: entry.ip, mac: entry.mac, source: 'local', reachable: entry.state === 'reachable', at: now })
    }
    this.store.pruneArp('local', keep, now)
    this.store.neighborsAt = now
  }

  private async withSnmp(device: PlannedDevice, work: (session: SnmpSession) => Promise<void>) {
    const options = resolveSnmp(this.store.settings, device)
    const raw = this.store.rawSwitch(device.id)
    if (!this.store.isInUse(device.id)) {
      raw.lastError = null
      return
    }
    if (!options) {
      raw.lastError = 'no SNMP community configured'
      return
    }
    const now = Date.now()
    const ping = this.store.pings.get(device.managementIp)
    if (ping && !ping.alive && now - ping.at < 60_000) {
      // Do not pile SNMP timeouts onto a device that just failed a ping. A switch that blocks ICMP but
      // answers SNMP (never pinged OK, never polled OK) still gets an attempt every five minutes.
      const provenPingable = ping.lastAliveAt !== null
      const triedRecently = raw.lastAttemptAt !== null && now - raw.lastAttemptAt < 300_000
      if (provenPingable || (raw.lastOkAt === null && triedRecently)) {
        raw.lastError = 'unreachable (ping failed)'
        return
      }
    }
    raw.lastAttemptAt = now
    const session = this.transports.snmp.open(options)
    try {
      await work(session)
    } catch (error) {
      raw.lastError = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      session.close()
    }
  }

  private async sysInfo(device: PlannedDevice) {
    const options = resolveSnmp(this.store.settings, device)
    if (!options || !this.store.isInUse(device.id)) return
    const previous = this.store.sysInfo.get(device.id) ?? null
    const session = this.transports.snmp.open(options)
    try {
      this.store.sysInfo.set(device.id, await pollSysInfo(session))
    } catch (error) {
      const failed: RawSysInfo = {
        ...(previous ?? { descr: null, name: null, upTimeTicks: null, lastOkAt: null, lastDurationMs: null }),
        at: Date.now(),
        lastError: error instanceof Error ? error.message : String(error),
      }
      this.store.sysInfo.set(device.id, failed)
      throw error
    } finally {
      session.close()
    }
  }

  private async routerArp(device: PlannedDevice) {
    const options = resolveSnmp(this.store.settings, device)
    if (!options || !this.store.isInUse(device.id)) return
    const session = this.transports.snmp.open(options)
    try {
      const entries = await pollRouterArp(session)
      const now = Date.now()
      const keep = new Set<string>()
      for (const entry of entries) {
        keep.add(`${entry.ip}|${entry.mac}`)
        // The local table knows freshness; never downgrade a reachable local entry.
        const existing = this.store.arp.get(`${entry.ip}|${entry.mac}`)
        if (existing?.source === 'local' && now - existing.at < 120_000) continue
        this.store.recordArp(entry)
      }
      this.store.pruneArp('router', keep, now)
      this.store.routerArpAt = now
    } finally {
      session.close()
    }
  }

  private async routerTraffic(device: PlannedDevice) {
    const options = resolveSnmp(this.store.settings, device)
    if (!options || !this.store.isInUse(device.id)) return
    const previous = this.store.routerTraffic.get(device.id) ?? null
    const session = this.transports.snmp.open(options)
    try {
      this.store.routerTraffic.set(
        device.id,
        await pollRouterTraffic(session, device.id, previous, { explicitWan: this.store.settings.internet.wanInterfaces, rediscoverAfterMs: this.store.settings.polling.snmpConfigSeconds * 1000 }),
      )
    } catch (error) {
      if (previous) this.store.routerTraffic.set(device.id, { ...previous, at: Date.now(), lastError: error instanceof Error ? error.message : String(error) })
      throw error
    } finally {
      session.close()
    }
  }

  private async sweep(cidr: string) {
    const parsed = parseCidr(cidr)
    if (!parsed) return
    const hosts = cidrHosts(parsed)
    const results = await this.transports.ping.ping(hosts, { timeoutMs: 700, concurrency: 24 })
    const now = Date.now()
    for (const result of results) this.store.recordPing(result.ip, result.alive, result.rttMs, now)
    // ARP entries for hosts that answered are refreshed on the next neighbour read; nudge it.
    if (results.some((result) => result.alive)) this.scheduler.request((id) => id === 'neighbors')
  }

  private async reverseDns() {
    const now = Date.now()
    const maxAge = this.store.settings.polling.dnsSeconds * 1000
    const candidates = new Set<string>()
    for (const ping of this.store.pings.values()) if (ping.alive) candidates.add(ping.ip)
    for (const entry of this.store.arp.values()) candidates.add(entry.ip)
    let budget = 60
    for (const ip of candidates) {
      if (budget <= 0) break
      const cached = this.store.dns.get(ip)
      if (cached && now - cached.at < maxAge) continue
      budget -= 1
      this.store.dns.set(ip, { hostname: await this.transports.dns.reverse(ip), at: now })
    }
  }

  /** WAN reachability from the Pi's point of view plus a real DNS resolution through the configured resolver. */
  private async internetCheck() {
    const { internet } = this.store.settings
    const targets = internet.targets.map((target) => target.trim()).filter(Boolean)
    const results = await this.transports.ping.ping(targets, { timeoutMs: 1500 })
    const now = Date.now()
    for (const result of results) {
      const previous = this.store.internet.get(result.ip)
      this.store.internet.set(result.ip, {
        ip: result.ip,
        alive: result.alive,
        rttMs: result.alive ? result.rttMs : (previous?.rttMs ?? null),
        at: now,
        lastAliveAt: result.alive ? now : (previous?.lastAliveAt ?? null),
      })
    }
    for (const key of [...this.store.internet.keys()]) if (!targets.includes(key)) this.store.internet.delete(key)
    if (internet.dnsCheckHost) {
      try {
        const addresses = await this.transports.dns.resolve(internet.dnsCheckHost)
        this.store.dnsCheck = { host: internet.dnsCheckHost, ok: addresses.length > 0, resolvedTo: addresses[0] ?? null, error: null, at: now, resolvers: this.transports.dns.servers() }
      } catch (error) {
        this.store.dnsCheck = { host: internet.dnsCheckHost, ok: false, resolvedTo: null, error: error instanceof Error ? error.message : String(error), at: now, resolvers: this.transports.dns.servers() }
      }
    } else this.store.dnsCheck = null
  }

  private async omada() {
    await pollOmada(this.store)
  }

  private async accessPoint(device: PlannedDevice) {
    if (!device.managementIp || !this.store.isInUse(device.id)) return
    const { accessPoints } = this.store.settings
    await this.eap.poll(
      { id: device.id, name: device.name, host: device.managementIp },
      { credentials: { username: accessPoints.username, password: accessPoints.password }, timeoutMs: accessPoints.timeoutMs, detailEvery: accessPoints.detailEvery },
      this.store,
    )
  }

  /** Which planned subnets does this host have a directly connected interface in? */
  static localSubnets(transports: Transports, store: Store) {
    return transports.interfaces().map((iface) => {
      const subnet = store.inventory.subnets.find((item) => {
        const parsed = parseCidr(item.cidr)
        return parsed ? cidrContains(parsed, iface.ip) : false
      })
      return { ...iface, vlanId: subnet?.vlanId ?? null }
    })
  }
}
