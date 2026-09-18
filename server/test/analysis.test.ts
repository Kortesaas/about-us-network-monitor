import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { MonitorState } from '@shared/types'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'aboutus-monitor-test-'))
process.env.MONITOR_MODE = 'demo'

/**
 * Runs the real pollers against the simulated network and checks the
 * derived state — the same path the Pi takes, minus the scheduler.
 */
describe('end-to-end analysis on the demo network', () => {
  let state: MonitorState

  beforeAll(async () => {
    const { parseInventory } = await import('../src/inventory/plan.js')
    const { defaultSettings } = await import('../src/settings.js')
    const { Store } = await import('../src/state/store.js')
    const { createDemoTransports, DEMO_AP_PASSWORD } = await import('../src/poll/demo.js')
    const { Poller } = await import('../src/poll/jobs.js')
    const inventory = parseInventory(JSON.parse(readFileSync(resolve(__dirname, '../../config/inventory.json'), 'utf8')), 'test')
    const settings = defaultSettings()
    settings.accessPoints.password = DEMO_AP_PASSWORD
    const store = new Store(inventory, settings, {
      version: 'test',
      mode: 'demo',
      hostname: 'test',
      startedAt: new Date().toISOString(),
      platform: 'test',
      capabilities: { fping: false, ping: true, ipNeigh: true, arp: true, snmp: true },
      interfaces: [],
      notices: [],
    })
    const transports = createDemoTransports(inventory)
    const poller = new Poller(store, transports)
    store.attachScanStatus(() => poller.scheduler.status())
    poller.configure()
    // Run every job once, directly, in a sensible order.
    const jobs = poller.scheduler.status().jobs.map((job) => job.id)
    const run = async (id: string) => {
      const spec = (poller.scheduler as unknown as { jobs: Map<string, { run: () => Promise<void> }> }).jobs.get(id)
      if (spec) await spec.run().catch(() => undefined)
    }
    for (const id of jobs.filter((id) => id === 'infra-ping' || id === 'neighbors')) await run(id)
    for (const id of jobs.filter((id) => id.startsWith('switch-config'))) await run(id)
    for (const id of jobs.filter((id) => id.startsWith('switch-fast') || id.startsWith('switch-tables') || id.startsWith('router-arp') || id.startsWith('sysinfo'))) await run(id)
    for (const id of jobs.filter((id) => id.startsWith('sweep:') || id === 'dns')) await run(id)
    // Two AP and router-traffic polls: the second one has counters to derive throughput from.
    for (const round of [0, 1]) for (const id of jobs.filter((id) => id.startsWith('ap:') || id.startsWith('router-traffic:'))) await run(id).then(() => round)
    store.publish()
    // Devices that answered joined the setup automatically; the offline Jakob switch has to be added by hand.
    expect(store.isInUse('switch-foh')).toBe(true)
    expect(store.isInUse('switch-stage-b')).toBe(false)
    expect(store.current().problems.some((problem) => problem.subject.id === 'switch-stage-b')).toBe(false)
    store.setInUse('switch-stage-b', true, 'manual')
    store.publish()
    state = store.current()
  }, 30_000)

  it('polls the reachable switches over SNMP and maps their ports', () => {
    const foh = state.switches.find((sw) => sw.id === 'switch-foh')!
    expect(foh.snmp.ok).toBe(true)
    expect(foh.portMappingNote).toContain('Dell')
    expect(foh.ports).toHaveLength(28)
    expect(foh.ports.find((port) => port.number === 23)?.diffs).toEqual([{ kind: 'native-vlan', planned: 99, discovered: 1 }])
    const jakob = state.switches.find((sw) => sw.id === 'switch-stage-b')!
    expect(jakob.reachability).toBe('offline')
    expect(jakob.snmp.ok).toBe(false)
    expect(state.infra.find((item) => item.id === 'switch-stage-b')?.inUseSource).toBe('manual')
    expect(state.infra.find((item) => item.id === 'switch-foh')?.inUseSource).toBe('auto')
  })

  it('treats the tagged Pi as one host in VLAN 99, not as a VLAN mismatch', () => {
    const pi = state.devices.find((device) => device.infraId && device.primaryIp === '192.168.99.2')!
    expect(pi.vlanId).toBe(99)
    expect(pi.location).toMatchObject({ port: 21 })
    expect(pi.flags.some((flag) => flag.includes('learned it on VLAN'))).toBe(false)
    expect(state.problems.some((problem) => problem.code === 'device-vlan-mismatch' && problem.subject.id === pi.id)).toBe(false)
    // Its planned port is labelled "PI" on the FOH switch, and that is where LLDP sees it.
    expect(state.problems.some((problem) => problem.code === 'infra-wrong-port')).toBe(false)
  })

  it('locates infrastructure through LLDP', () => {
    const router = state.infra.find((item) => item.managementIp === '192.168.99.1')!
    expect(router.locatedAt).toMatchObject({ port: 23 })
    const pi = state.infra.find((item) => item.managementIp === '192.168.99.2')!
    expect(pi.locatedAt).toMatchObject({ port: 21 })
    const external = state.infra.find((item) => item.managementIp === '192.168.1.1')!
    expect(external.monitored).toBe(false)
    expect(external.reachability).toBe('unknown')
  })

  it('correlates devices by MAC and finds their edge port, not the uplink', () => {
    const console = state.devices.find((device) => device.ips.includes('192.168.20.50'))!
    expect(console.status).toBe('located')
    expect(console.location).toMatchObject({ port: 9 })
    expect(console.location?.switchName).toBe('Dell Stage A')
    const tplinkClient = state.devices.find((device) => device.ips.includes('192.168.10.90'))!
    expect(tplinkClient.location?.switchName).toBe('T1600G-28TS')
    const unlocated = state.devices.find((device) => device.ips.includes('192.168.40.60'))!
    expect(unlocated.status).toBe('unlocated')
    expect(unlocated.online).toBe(true)
  })

  it('folds gateway addresses into the router and hides MAC-only observations', () => {
    const router = state.devices.find((device) => device.infraId && device.ips.includes('192.168.99.1'))!
    expect(router.ips).toContain('192.168.10.1')
    expect(router.primaryIp).toBe('192.168.99.1')
    expect(state.devices.some((device) => device.id === 'ip:192.168.10.1')).toBe(false)
    const macOnly = state.devices.filter((device) => device.macOnly)
    expect(macOnly.length).toBeGreaterThan(0)
    expect(macOnly.every((device) => device.ips.length === 0)).toBe(true)
  })

  it('raises the expected production problems', () => {
    const codes = state.problems.map((problem) => problem.code)
    expect(codes).toContain('infra-offline')
    expect(codes).toContain('snmp-failed')
    expect(codes).toContain('access-vlan-mismatch')
    expect(codes).toContain('native-vlan-mismatch')
    expect(codes).toContain('ap-trunk-mismatch')
    expect(codes).toContain('trunk-extra-vlan')
    expect(codes).toContain('device-vlan-mismatch')
    // SFP cages that never had link are not "down uplinks".
    expect(state.problems.filter((problem) => problem.code === 'uplink-down' && problem.subject.label.includes('port 25'))).toHaveLength(0)
    expect(state.summary.health).toBe('critical')
  })

  it('builds the topology from LLDP with both ends of a switch link merged', () => {
    const lldp = state.topology.edges.filter((edge) => edge.origin === 'lldp')
    const trunk = lldp.find((edge) => edge.sourcePort === 26 || edge.targetPort === 26)!
    expect(trunk).toBeDefined()
    expect([trunk.sourcePort, trunk.targetPort].sort()).toEqual([25, 26])
    expect(lldp.filter((edge) => new Set([edge.source, edge.target]).has('switch-foh') && new Set([edge.source, edge.target]).has('switch-stage-a'))).toHaveLength(1)
  })

  it('lists VLAN membership and ports carrying each VLAN', () => {
    const audio = state.vlans.find((vlan) => vlan.vlanId === 20)!
    expect(audio.onlineDeviceCount).toBeGreaterThanOrEqual(5)
    expect(audio.ports.some((port) => port.switchId === 'switch-foh' && port.port === 9 && !port.tagged)).toBe(true)
    expect(audio.ports.some((port) => port.switchId === 'switch-foh' && port.port === 22 && port.tagged)).toBe(true)
  })
  it('measures internet throughput on the router WAN link and per-VLAN edge traffic', () => {
    expect(state.traffic.wan).not.toBeNull()
    expect(state.traffic.wan!.interfaces.map((iface) => iface.name)).toEqual(['DSL-1'])
    expect(state.traffic.wan!.inBps).toBeGreaterThan(0)
    const wan = state.traffic.series.find((item) => item.kind === 'wan')!
    expect(wan.samples.length).toBeGreaterThanOrEqual(1)
    expect(state.traffic.series.some((item) => item.kind === 'router-link')).toBe(true)
    const audio = state.traffic.series.find((item) => item.id === 'vlan:20')
    expect(audio?.inBps).not.toBeNull()
  })

  describe('standalone access points', () => {
    it('reads radios, SSIDs and clients from the FOH AP through its web API', () => {
      const foh = state.wlan.accessPoints.find((ap) => ap.ip === '192.168.99.30')!
      expect(state.wlan.configured).toBe(true)
      expect(foh.source).toBe('eap')
      expect(foh.poll?.ok).toBe(true)
      expect(foh.model).toBe('EAP650')
      expect(foh.radios.map((radio) => [radio.band, radio.channel])).toEqual([
        ['2.4 GHz', 6],
        ['5 GHz', 44],
      ])
      expect(state.wlan.ssids.find((ssid) => ssid.ssid === 'ABOUTUS-Control')).toMatchObject({ vlanId: 10, bands: ['2.4 GHz', '5 GHz'] })
      expect(foh.clients.map((client) => client.hostname).sort()).toEqual(['ipad-manu', 'iphone-manu', 'ma3-onpc-tablet'])
      // The AP itself is located on the switch, so its clients inherit that entry point.
      expect(foh.locatedAt).toMatchObject({ switchId: 'switch-foh', port: 22 })
    })

    it('gives Wi-Fi devices their AP, SSID, signal and the VLAN of the SSID', () => {
      const phone = state.devices.find((device) => device.hostname?.startsWith('iphone-manu'))!
      expect(phone.wireless).toMatchObject({ ap: 'AP Manu FOH', ssid: 'ABOUTUS-Control', band: '5 GHz', quality: 'excellent', apLocation: { switchId: 'switch-foh', port: 22 } })
      expect(phone.sources).toContain('wifi')
      expect(phone.status).toBe('located')
      const ipad = state.devices.find((device) => device.hostname?.startsWith('ipad-manu'))!
      expect(ipad.wireless?.quality).toBe('fair')
      const wlanClient = state.wlan.clients.find((client) => client.deviceId === phone.id)!
      expect(wlanClient.rxBps).not.toBeNull()
      expect(wlanClient.vlanId).toBe(10)
    })

    it('lists every planned AP with its poll state, even the flapping one', () => {
      const stage = state.wlan.accessPoints.find((ap) => ap.ip === '192.168.99.31')!
      expect(stage.poll).not.toBeNull()
      if (stage.poll!.ok) expect(stage.clients.map((client) => client.hostname)).toContain('video-op-phone')
      else expect(state.problems.some((problem) => problem.code === 'ap-poll-failed' && problem.subject.id === stage.id) || stage.reachability !== 'online').toBe(true)
    })
  })
})

describe('duplicate IP detection', () => {
  it('flags two live MACs claiming one address', async () => {
    const { parseInventory } = await import('../src/inventory/plan.js')
    const { defaultSettings } = await import('../src/settings.js')
    const { Store } = await import('../src/state/store.js')
    const inventory = parseInventory(JSON.parse(readFileSync(resolve(__dirname, '../../config/inventory.json'), 'utf8')), 'test')
    const store = new Store(inventory, defaultSettings(), {
      version: 'test',
      mode: 'demo',
      hostname: 'test',
      startedAt: new Date().toISOString(),
      platform: 'test',
      capabilities: { fping: false, ping: true, ipNeigh: true, arp: true, snmp: true },
      interfaces: [],
      notices: [],
    })
    const now = Date.now()
    // The router's ARP entry flipped between two MACs across two polls.
    store.recordArp({ ip: '192.168.10.150', mac: '3c:22:fb:00:00:08', source: 'router', reachable: false, at: now - 60_000 })
    store.recordArp({ ip: '192.168.10.150', mac: 'b8:27:eb:00:00:09', source: 'router', reachable: false, at: now })
    store.recordPing('192.168.10.150', true, 1.2, now)
    store.publish()
    const state = store.current()
    const problem = state.problems.find((item) => item.code === 'duplicate-ip')
    expect(problem?.title).toBe('Duplicate IP 192.168.10.150')
    expect(state.devices.filter((device) => device.ips.includes('192.168.10.150'))).toHaveLength(2)
    expect(state.devices.filter((device) => device.ips.includes('192.168.10.150')).every((device) => device.flags.some((flag) => flag.startsWith('duplicate IP')))).toBe(true)
  })
})
