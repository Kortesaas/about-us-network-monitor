import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import type { BackendInfo } from '@shared/types'
import { cidrContains, parseCidr } from '@shared/ip'
import { config } from './config.js'
import { log } from './logger.js'
import { loadSettings } from './settings.js'
import { loadInventory } from './inventory/plan.js'
import { Store } from './state/store.js'
import { Poller } from './poll/jobs.js'
import { createDemoTransports, DEMO_AP_PASSWORD } from './poll/demo.js'
import { createPingTransport, which } from './poll/ping.js'
import { createNeighborSource, localInterfaces } from './poll/neighbors.js'
import { SystemDnsResolver } from './poll/dns.js'
import { NetSnmpTransport } from './poll/snmp/client.js'
import { createHttpClient } from './poll/eap.js'
import { SyslogReceiver } from './poll/syslog.js'
import type { Transports } from './poll/transport.js'
import { createApp } from './http/app.js'

const logger = log('main')

async function main() {
  mkdirSync(config.dataDir, { recursive: true })
  logger.info(`ABOUTUS network monitor v${config.version} starting in ${config.mode} mode (node ${process.version}, ${process.platform}/${process.arch})`)

  const settings = loadSettings()
  const inventory = loadInventory()
  // The simulated EAPs accept a fixed password so the WLAN page works out of the box in demo mode.
  if (config.mode === 'demo' && !settings.accessPoints.password) settings.accessPoints.password = DEMO_AP_PASSWORD

  const transports: Transports =
    config.mode === 'demo'
      ? createDemoTransports(inventory)
      : {
          ping: await createPingTransport(),
          neighbors: await createNeighborSource(),
          snmp: new NetSnmpTransport(),
          dns: new SystemDnsResolver(),
          http: createHttpClient(),
          interfaces: localInterfaces,
        }

  const interfaces = transports.interfaces().map((iface) => {
    const subnet = inventory.subnets.find((item) => {
      const parsed = parseCidr(item.cidr)
      return parsed ? cidrContains(parsed, iface.ip) : false
    })
    return { ...iface, vlanId: subnet?.vlanId ?? null }
  })

  const notices: string[] = []
  if (config.mode === 'demo') notices.push('Demo mode: all data is simulated. Start without MONITOR_MODE=demo on the Pi for live data.')
  if (config.mode === 'live') {
    if (transports.ping.tool === 'ping') notices.push('fping is not installed — sweeps use the slower system ping. Install with: sudo apt install fping')
    if (transports.ping.tool === 'none') notices.push('No ping tool found — reachability checks are disabled.')
    if (!transports.neighbors.available) notices.push('No neighbour table source (ip / arp) found — local IP↔MAC learning is disabled.')
    if (!transports.snmp.available) notices.push('net-snmp module missing — SNMP polling is disabled.')
    const reachable = new Set(interfaces.map((iface) => iface.vlanId).filter((vlan) => vlan !== null))
    const missing = inventory.subnets.filter((subnet) => subnet.vlanId !== null && subnet.vlanId !== 90 && !reachable.has(subnet.vlanId))
    if (missing.length && interfaces.length)
      notices.push(
        `The Pi has no interface in VLAN ${missing.map((subnet) => subnet.vlanId).join(', ')} — devices there are found via the router ARP table and routed sweeps only. See docs/deployment.md to add VLAN sub-interfaces.`,
      )
  }

  const backend: BackendInfo = {
    version: config.version,
    mode: config.mode,
    hostname: config.hostname,
    startedAt: new Date().toISOString(),
    platform: `${process.platform}/${process.arch} node ${process.version}`,
    capabilities: {
      fping: transports.ping.tool === 'fping',
      ping: transports.ping.tool !== 'none',
      ipNeigh: transports.neighbors.available && (config.mode === 'demo' || (await which('ip'))),
      arp: transports.neighbors.available,
      snmp: transports.snmp.available,
    },
    interfaces,
    notices,
  }

  const store = new Store(inventory, settings, backend)
  store.notices = notices
  const poller = new Poller(store, transports)
  store.attachScanStatus(() => poller.scheduler.status())
  const syslog = new SyslogReceiver(store)
  const applySyslog = () => (store.settings.syslog.enabled ? syslog.start(store.settings.syslog.port) : syslog.stop())

  const { app, live } = createApp({
    store,
    poller,
    onSettingsChanged: () => {
      poller.configure()
      applySyslog()
    },
    onInventoryChanged: () => {
      for (const device of store.inventory.devices) if (device.type === 'switch') store.rawSwitch(device.id)
      poller.configure()
    },
  })

  store.addEvent({ kind: 'system', severity: 'info', message: `Monitor started (${config.mode} mode)`, subject: null })
  store.publish()
  poller.start()
  applySyslog()

  const server = createServer(app)
  server.listen(config.port, config.host, () => {
    logger.info(`listening on http://${config.host === '0.0.0.0' ? config.hostname : config.host}:${config.port}`)
  })
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EACCES')
      logger.error(`cannot bind port ${config.port}: permission denied. Run with PORT=8080 or grant CAP_NET_BIND_SERVICE (see deploy/aboutus-net-monitor.service).`)
    else if (error.code === 'EADDRINUSE') logger.error(`port ${config.port} is already in use`)
    else logger.error('server error', error)
    process.exit(1)
  })

  const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down`)
    poller.stop()
    syslog.stop()
    live.close()
    store.save(true)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('unhandledRejection', (reason) => logger.error('unhandled rejection', reason instanceof Error ? reason : new Error(String(reason))))
}

main().catch((error) => {
  logger.error('fatal', error)
  process.exit(1)
})
