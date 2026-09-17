import type { PlannedDevice } from '@shared/types'
import type { Inventory } from '../inventory/plan.js'
import type {
  DnsResolver,
  NeighborEntry,
  NeighborSource,
  PingResult,
  PingTransport,
  SnmpSession,
  SnmpSessionOptions,
  SnmpTransport,
  SnmpValue,
  SnmpVarbind,
  Transports,
} from './transport.js'
import { OID } from './snmp/oids.js'

/**
 * A simulated show network for `MONITOR_MODE=demo`. It answers pings, fills a
 * neighbour table and serves SNMP tables exactly like real devices would, so
 * every parser and every UI state can be exercised without the rack. The
 * scenario deliberately contains problems (an offline switch, a wrong VLAN, a
 * flapping AP, a duplicate IP, a moving laptop…).
 */

type SimClient = {
  mac: string
  ip: string | null
  vlan: number
  switchId: string | null
  port: number | null
  hostname: string | null
  online: (t: number) => boolean
  /** Alternative location (for the wandering laptop). */
  moveTo?: { switchId: string; port: number; every: number }
}

const START = Date.now()
const minutes = (n: number) => n * 60_000
const cycle = (t: number, period: number) => (t - START) % period

function mac(seed: number, prefix = '00:1b:63') {
  const tail = [(seed >> 16) & 255, (seed >> 8) & 255, seed & 255].map((n) => n.toString(16).padStart(2, '0'))
  return `${prefix}:${tail.join(':')}`
}

export class DemoNetwork {
  readonly switches: PlannedDevice[]
  readonly router: PlannedDevice | undefined
  readonly clients: SimClient[] = []
  readonly infraMacs = new Map<string, string>()
  private readonly offlineIds = new Set<string>()
  private readonly snmpBroken = new Set<string>()
  private readonly flapping = new Set<string>()

  constructor(readonly inventory: Inventory) {
    this.switches = inventory.devices.filter((device) => device.type === 'switch')
    this.router = inventory.devices.find((device) => device.type === 'router' && device.managementVlanId === 99)
    inventory.devices.forEach((device, index) => this.infraMacs.set(device.id, mac(0x100 + index, vendorPrefix(device))))

    const byIp = this.find.bind(this)
    const jakob = byIp('switch-stage-b') ?? this.switches[2]
    const allied = byIp('192.168.99.20') ?? this.switches[3]
    const apStage = byIp('192.168.99.31')
    if (jakob) this.offlineIds.add(jakob.id)
    if (allied) this.snmpBroken.add(allied.id)
    if (apStage) this.flapping.add(apStage.id)

    const foh = byIp('switch-foh') ?? this.switches[0]
    const stage = byIp('switch-stage-a') ?? this.switches[1]
    const tplink = byIp('192.168.99.21') ?? this.switches[4]
    const always = () => true
    const add = (client: Omit<SimClient, 'online'> & { online?: (t: number) => boolean }) =>
      this.clients.push({ online: always, ...client })
    if (foh) {
      add({ mac: mac(1, '00:1a:8c'), ip: '192.168.10.10', vlan: 10, switchId: foh.id, port: 1, hostname: 'qlab-main' })
      add({ mac: mac(2, 'a4:83:e7'), ip: '192.168.10.11', vlan: 10, switchId: foh.id, port: 2, hostname: 'manu-macbook' })
      add({ mac: mac(3, '00:1d:c1'), ip: '192.168.20.20', vlan: 20, switchId: foh.id, port: 9, hostname: 'dante-foh' })
      add({ mac: mac(4, '00:1d:c1'), ip: '192.168.20.21', vlan: 20, switchId: foh.id, port: 10, hostname: 'sq7-console' })
      add({ mac: mac(5, '00:0f:e5'), ip: '192.168.30.30', vlan: 30, switchId: foh.id, port: 13, hostname: 'grandma3-foh' })
      add({ mac: mac(6, 'd8:9e:f3'), ip: '192.168.40.40', vlan: 40, switchId: foh.id, port: 17, hostname: 'resolume-a' })
      add({ mac: mac(7, 'd8:9e:f3'), ip: '192.168.40.41', vlan: 40, switchId: foh.id, port: 18, hostname: 'media-server-b', online: (t) => cycle(t, minutes(10)) > minutes(2) })
      add({ mac: mac(8, '3c:22:fb'), ip: '192.168.10.150', vlan: 10, switchId: foh.id, port: 3, hostname: 'ipad-stagemgr' })
      // Duplicate IP: a second device with a static address that clashes with the iPad.
      add({ mac: mac(9, 'b8:27:eb'), ip: '192.168.10.150', vlan: 10, switchId: foh.id, port: 5, hostname: null })
      // Wi-Fi clients behind the AP trunk port (22).
      add({ mac: mac(10, 'f0:2f:4b'), ip: '192.168.10.120', vlan: 10, switchId: foh.id, port: 22, hostname: 'iphone-manu' })
      add({ mac: mac(11, '2c:f0:5d'), ip: '192.168.30.121', vlan: 30, switchId: foh.id, port: 22, hostname: 'ma3-onpc-tablet' })
    }
    if (stage) {
      add({ mac: mac(20, '00:1d:c1'), ip: '192.168.20.50', vlan: 20, switchId: stage.id, port: 9, hostname: 'stagebox-dante' })
      add({ mac: mac(21, '00:1d:c1'), ip: '192.168.20.51', vlan: 20, switchId: stage.id, port: 10, hostname: 'monitor-desk' })
      add({ mac: mac(22, '00:0f:e5'), ip: '192.168.30.50', vlan: 30, switchId: stage.id, port: 13, hostname: 'dmx-node-1' })
      // Wrong VLAN: an AUDIO address plugged into a LIGHT port.
      add({ mac: mac(23, '00:1d:c1'), ip: '192.168.20.77', vlan: 30, switchId: stage.id, port: 14, hostname: null })
      add({ mac: mac(24, 'd8:9e:f3'), ip: '192.168.40.50', vlan: 40, switchId: stage.id, port: 17, hostname: 'led-processor' })
      // MAC only: a device that never got an IP.
      add({ mac: mac(25, '00:04:f2'), ip: null, vlan: 10, switchId: stage.id, port: 2, hostname: null })
      add({ mac: mac(26, 'a4:83:e7'), ip: '192.168.10.60', vlan: 10, switchId: stage.id, port: 4, hostname: 'laptop-jakob', moveTo: tplink ? { switchId: tplink.id, port: 5, every: minutes(4) } : undefined })
    }
    if (tplink) {
      add({ mac: mac(30, '00:1d:c1'), ip: '192.168.20.90', vlan: 20, switchId: tplink.id, port: 9, hostname: 'drum-mixer' })
      add({ mac: mac(31, '00:0f:e5'), ip: '192.168.30.90', vlan: 30, switchId: tplink.id, port: 13, hostname: 'dmx-node-2' })
      add({ mac: mac(32, 'b8:27:eb'), ip: '192.168.10.90', vlan: 10, switchId: tplink.id, port: 3, hostname: 'timecode-pi' })
    }
    // Unlocated: answers pings and is in the router ARP table, but on the offline Jakob switch.
    add({ mac: mac(40, 'a4:83:e7'), ip: '192.168.40.60', vlan: 40, switchId: null, port: null, hostname: 'jakob-laptop' })
  }

  /** Scenario devices are addressed by inventory id where the planner has stable ids, else by management IP. */
  find(idOrIp: string) {
    return this.inventory.devices.find((device) => device.id === idOrIp) ?? this.inventory.devices.find((device) => device.managementIp === idOrIp)
  }

  private is(device: PlannedDevice, idOrIp: string) {
    return device.id === idOrIp || device.managementIp === idOrIp
  }

  isOnline(device: PlannedDevice, t: number) {
    if (this.offlineIds.has(device.id)) return false
    if (this.flapping.has(device.id)) return cycle(t, 60_000) < 40_000
    return true
  }

  snmpWorks(device: PlannedDevice) {
    return !this.snmpBroken.has(device.id) && !this.offlineIds.has(device.id)
  }

  locationOf(client: SimClient, t: number): { switchId: string; port: number } | null {
    if (!client.switchId || !client.port) return null
    if (client.moveTo && cycle(t, client.moveTo.every * 2) >= client.moveTo.every) return client.moveTo
    return { switchId: client.switchId, port: client.port }
  }

  /** Full MIB of a switch at time t as an OID → value map. */
  switchMib(device: PlannedDevice, t: number): Map<string, SnmpValue> {
    const mib = new Map<string, SnmpValue>()
    const isDell = /dell/i.test(device.manufacturer)
    const isTpLink = /tp-?link/i.test(device.manufacturer)
    const total = device.portCount + device.sfpPortCount + device.wanPortCount
    const uptime = Math.floor((t - START + minutes(90)) / 10)
    mib.set(OID.sysDescr, Buffer.from(isDell ? 'Dell EMC Networking N1524P, 6.6.4.9, Linux 3.6.5' : isTpLink ? 'JetStream 24-Port Gigabit L2 Managed Switch with 4 SFP Slots' : `${device.manufacturer} ${device.model}`))
    mib.set(OID.sysName, Buffer.from(device.name.replace(/\s+/g, '-').toUpperCase()))
    mib.set(OID.sysLocation, Buffer.from(device.location))
    mib.set(OID.sysUpTime, uptime)
    mib.set(OID.sysObjectID, '1.3.6.1.4.1.674.10895.3065')

    const ifName = (port: number) =>
      isDell ? (port <= device.portCount ? `Gi1/0/${port}` : `Te1/0/${port - device.portCount}`) : isTpLink ? `gigabitEthernet 1/0/${port}` : `Port ${port}`
    const isUp = (port: number) => this.portUp(device, port, t)
    for (let port = 1; port <= total; port += 1) {
      const ifIndex = port
      const speed = port > device.portCount ? 10_000 : 1000
      mib.set(`${OID.ifDescr}.${ifIndex}`, Buffer.from(ifName(port)))
      mib.set(`${OID.ifName}.${ifIndex}`, Buffer.from(ifName(port)))
      mib.set(`${OID.ifAlias}.${ifIndex}`, Buffer.from(device.ports.find((p) => p.number === port)?.name ?? ''))
      mib.set(`${OID.ifType}.${ifIndex}`, 6)
      mib.set(`${OID.ifPhysAddress}.${ifIndex}`, Buffer.from(this.infraMacs.get(device.id)!.replace(/:/g, ''), 'hex'))
      mib.set(`${OID.ifAdminStatus}.${ifIndex}`, 1)
      mib.set(`${OID.ifOperStatus}.${ifIndex}`, isUp(port) ? 1 : 2)
      mib.set(`${OID.ifLastChange}.${ifIndex}`, Math.max(0, uptime - port * 6000))
      mib.set(`${OID.ifHighSpeed}.${ifIndex}`, isUp(port) ? (isTpLink && port === 7 ? 100 : speed) : 0)
      const load = isUp(port) ? this.trafficFor(device, port) : 0
      const elapsed = (t - START) / 1000
      mib.set(`${OID.ifHCInOctets}.${ifIndex}`, BigInt(Math.floor(elapsed * load * (1 + 0.3 * Math.sin(t / 20000 + port)))))
      mib.set(`${OID.ifHCOutOctets}.${ifIndex}`, BigInt(Math.floor(elapsed * load * 0.6)))
      const errors = isTpLink && port === 3 ? Math.floor(elapsed / 5) : 0
      mib.set(`${OID.ifInErrors}.${ifIndex}`, errors)
      mib.set(`${OID.ifOutErrors}.${ifIndex}`, 0)
      mib.set(`${OID.ifInDiscards}.${ifIndex}`, 0)
      mib.set(`${OID.ifOutDiscards}.${ifIndex}`, 0)
      mib.set(`${OID.dot1dBasePortIfIndex}.${port}`, ifIndex)
      mib.set(`${OID.lldpLocPortIdSubtype}.${ifIndex}`, 5)
      mib.set(`${OID.lldpLocPortId}.${ifIndex}`, Buffer.from(ifName(port)))
      mib.set(`${OID.lldpLocPortDesc}.${ifIndex}`, Buffer.from(ifName(port)))
    }
    // A logical VLAN interface, to make sure the port mapper ignores it.
    mib.set(`${OID.ifDescr}.1099`, Buffer.from('Vl99'))
    mib.set(`${OID.ifName}.1099`, Buffer.from('Vl99'))
    mib.set(`${OID.ifType}.1099`, 53)
    mib.set(`${OID.ifOperStatus}.1099`, 1)

    // VLAN tables from the plan, with deliberate deviations.
    const vlanPorts = new Map<number, { egress: Set<number>; untagged: Set<number> }>()
    const ensure = (vlan: number) => {
      let entry = vlanPorts.get(vlan)
      if (!entry) {
        entry = { egress: new Set(), untagged: new Set() }
        vlanPorts.set(vlan, entry)
      }
      return entry
    }
    for (const vlan of this.inventory.vlans) if (vlan.vlanId !== 90) ensure(vlan.vlanId)
    ensure(1)
    for (const planned of device.ports) {
      const port = planned.number
      let access = planned.accessVlanId
      let native = planned.nativeVlanId
      let tagged = [...planned.taggedVlanIds]
      if (this.is(device, 'switch-foh') && port === 23) native = 1
      if (this.is(device, 'switch-stage-a') && port === 9) access = 10
      if (this.is(device, 'switch-stage-a') && port === 23) tagged = tagged.filter((vlan) => vlan !== 40)
      if (this.is(device, '192.168.99.21') && port === 22) tagged.push(90)
      if (planned.mode === 'access' && access !== null) {
        ensure(access).egress.add(port)
        ensure(access).untagged.add(port)
        mib.set(`${OID.dot1qPvid}.${port}`, access)
      } else if (planned.mode === 'trunk' || planned.mode === 'hybrid') {
        const pvid = native ?? 1
        ensure(pvid).egress.add(port)
        ensure(pvid).untagged.add(port)
        for (const vlan of tagged) if (vlan !== pvid) ensure(vlan).egress.add(port)
        mib.set(`${OID.dot1qPvid}.${port}`, pvid)
      } else {
        ensure(1).egress.add(port)
        ensure(1).untagged.add(port)
        mib.set(`${OID.dot1qPvid}.${port}`, 1)
      }
    }
    for (const [vlan, entry] of vlanPorts) {
      const name = this.inventory.vlans.find((item) => item.vlanId === vlan)?.name ?? (vlan === 1 ? 'default' : `VLAN${vlan}`)
      mib.set(`${OID.dot1qVlanStaticName}.${vlan}`, Buffer.from(name))
      mib.set(`${OID.dot1qVlanStaticEgressPorts}.${vlan}`, bitmap(entry.egress, total))
      mib.set(`${OID.dot1qVlanStaticUntaggedPorts}.${vlan}`, bitmap(entry.untagged, total))
    }

    // FDB: local clients on their edge port, everything else via the uplink that leads there.
    const uplinkFor = this.uplinkPort(device)
    for (const client of this.clients) {
      if (!client.online(t)) continue
      const location = this.locationOf(client, t)
      let port: number | null = null
      if (location?.switchId === device.id) port = location.port
      else if (location && uplinkFor(location.switchId) !== null) port = uplinkFor(location.switchId)
      if (port === null) continue
      mib.set(`${OID.dot1qTpFdbPort}.${client.vlan}.${macOid(client.mac)}`, port)
    }
    // Infra MACs: router and APs on their trunk ports.
    for (const link of this.links()) {
      if (link.a.switchId === device.id) {
        const remote = this.inventory.devices.find((item) => item.id === link.b.deviceId)
        if (remote && this.isOnline(remote, t) && remote.type !== 'switch')
          mib.set(`${OID.dot1qTpFdbPort}.99.${macOid(this.infraMacs.get(remote.id)!)}`, link.a.port)
      }
    }

    // LLDP neighbours.
    let remIndex = 1
    for (const link of this.links()) {
      const local = link.a.switchId === device.id ? link.a : link.b.switchId === device.id ? link.b : null
      const remote = local === link.a ? link.b : link.a
      if (!local || !local.port) continue
      const remoteDevice = this.inventory.devices.find((item) => item.id === remote.deviceId)
      if (!remoteDevice || !this.isOnline(remoteDevice, t) || !isUp(local.port)) continue
      const key = `0.${local.port}.${remIndex++}`
      const remoteMac = this.infraMacs.get(remoteDevice.id)!
      mib.set(`${OID.lldpRemChassisIdSubtype}.${key}`, 4)
      mib.set(`${OID.lldpRemChassisId}.${key}`, Buffer.from(remoteMac.replace(/:/g, ''), 'hex'))
      mib.set(`${OID.lldpRemPortIdSubtype}.${key}`, 5)
      mib.set(`${OID.lldpRemPortId}.${key}`, Buffer.from(remote.port ? `Gi1/0/${remote.port}` : 'eth0'))
      mib.set(`${OID.lldpRemPortDesc}.${key}`, Buffer.from(remote.port ? `Port ${remote.port}` : 'LAN'))
      mib.set(`${OID.lldpRemSysName}.${key}`, Buffer.from(remoteDevice.name.replace(/\s+/g, '-').toUpperCase()))
      mib.set(`${OID.lldpRemSysDesc}.${key}`, Buffer.from(`${remoteDevice.manufacturer} ${remoteDevice.model} ${remoteDevice.type === 'switch' ? 'Switch' : remoteDevice.type === 'router' ? 'Router' : remoteDevice.type === 'access-point' ? 'Access Point' : 'Linux (lldpd)'}`))
      mib.set(`${OID.lldpRemManAddrIfSubtype}.${key}.1.4.${remoteDevice.managementIp}`, 2)
    }
    return mib
  }

  routerMib(device: PlannedDevice, t: number): Map<string, SnmpValue> {
    const mib = new Map<string, SnmpValue>()
    mib.set(OID.sysDescr, Buffer.from('LANCOM 1783VAW 10.80.0212 / 2024-09-12'))
    mib.set(OID.sysName, Buffer.from(device.name.replace(/\s+/g, '-').toUpperCase()))
    mib.set(OID.sysUpTime, Math.floor((t - START + minutes(600)) / 10))
    const add = (ifIndex: number, ip: string, hw: string) => mib.set(`${OID.ipNetToMediaPhysAddress}.${ifIndex}.${ip}`, Buffer.from(hw.replace(/:/g, ''), 'hex'))
    // A real router holds one MAC per IP; with a duplicate address the entry flips between the two devices.
    const flip = Math.floor(t / 60_000) % 2 === 1
    const seen = new Set<string>()
    for (const client of [...this.clients].sort(() => (flip ? -1 : 1))) {
      if (!client.ip || !client.online(t) || seen.has(client.ip)) continue
      seen.add(client.ip)
      add(client.vlan, client.ip, client.mac)
    }
    for (const infra of this.inventory.devices)
      if (infra.managementIp && infra.id !== device.id && this.isOnline(infra, t)) add(99, infra.managementIp, this.infraMacs.get(infra.id)!)
    return mib
  }

  /* --- scenario helpers --- */

  private trafficFor(device: PlannedDevice, port: number) {
    const planned = device.ports.find((item) => item.number === port)
    if (!planned) return 0
    if (planned.mode === 'trunk') return 2_500_000
    if (planned.accessVlanId === 20) return 900_000
    if (planned.accessVlanId === 40) return 4_000_000
    return this.clients.some((client) => client.switchId === device.id && client.port === port) ? 120_000 : 0
  }

  portUp(device: PlannedDevice, port: number, t: number) {
    const planned = device.ports.find((item) => item.number === port)
    if (!planned) return false
    if (this.is(device, 'switch-foh') && port === 25) return false
    if (planned.role === 'sfp' && !this.links().some((link) => (link.a.switchId === device.id && link.a.port === port) || (link.b.switchId === device.id && link.b.port === port))) return false
    if (planned.mode === 'trunk' || planned.mode === 'hybrid') {
      const link = this.links().find((item) => (item.a.switchId === device.id && item.a.port === port) || (item.b.switchId === device.id && item.b.port === port))
      if (link) {
        const otherId = link.a.switchId === device.id ? link.b.deviceId : link.a.deviceId
        const other = this.inventory.devices.find((item) => item.id === otherId)
        return other ? this.isOnline(other, t) : true
      }
      return /ap/i.test(planned.name) ? true : false
    }
    return this.clients.some((client) => {
      const location = this.locationOf(client, t)
      return client.online(t) && location?.switchId === device.id && location.port === port
    })
  }

  /** Physical links of the scenario, by management IP so they survive inventory edits. */
  links(): { a: { switchId: string; port: number; deviceId: string }; b: { switchId: string | null; port: number | null; deviceId: string } }[] {
    const byIp = this.find.bind(this)
    const foh = byIp('switch-foh')
    const stage = byIp('switch-stage-a')
    const tplink = byIp('192.168.99.21')
    const router = byIp('192.168.99.1')
    const apFoh = byIp('192.168.99.30')
    const apStage = byIp('192.168.99.31')
    const pi = byIp('192.168.99.2')
    const out: ReturnType<DemoNetwork['links']> = []
    if (foh && router) out.push({ a: { switchId: foh.id, port: 23, deviceId: foh.id }, b: { switchId: null, port: 1, deviceId: router.id } })
    if (foh && pi) out.push({ a: { switchId: foh.id, port: 21, deviceId: foh.id }, b: { switchId: null, port: null, deviceId: pi.id } })
    if (foh && apFoh) out.push({ a: { switchId: foh.id, port: 22, deviceId: foh.id }, b: { switchId: null, port: 1, deviceId: apFoh.id } })
    if (foh && stage) out.push({ a: { switchId: foh.id, port: 26, deviceId: foh.id }, b: { switchId: stage.id, port: 25, deviceId: stage.id } })
    if (stage && apStage) out.push({ a: { switchId: stage.id, port: 23, deviceId: stage.id }, b: { switchId: null, port: 1, deviceId: apStage.id } })
    if (stage && tplink) out.push({ a: { switchId: stage.id, port: 22, deviceId: stage.id }, b: { switchId: tplink.id, port: 24, deviceId: tplink.id } })
    return out
  }

  /** Which local port leads towards another switch (for FDB entries seen via uplinks). */
  private uplinkPort(device: PlannedDevice) {
    const links = this.links()
    const byIp = this.find.bind(this)
    const foh = byIp('switch-foh')
    const stage = byIp('switch-stage-a')
    const tplink = byIp('192.168.99.21')
    return (targetSwitchId: string): number | null => {
      if (targetSwitchId === device.id) return null
      // Direct link?
      for (const link of links) {
        if (link.a.switchId === device.id && link.b.switchId === targetSwitchId) return link.a.port
        if (link.b.switchId === device.id && link.a.switchId === targetSwitchId) return link.b.port
      }
      // FOH ↔ TP-Link go through Stage A.
      if (device.id === foh?.id && targetSwitchId === tplink?.id) return 26
      if (device.id === tplink?.id && targetSwitchId === foh?.id) return 24
      if (device.id === stage?.id) return null
      return null
    }
  }
}

const bitmap = (ports: Set<number>, total: number) => {
  const bytes = Buffer.alloc(Math.ceil(total / 8) + 1)
  for (const port of ports) bytes[Math.floor((port - 1) / 8)]! |= 0x80 >> ((port - 1) % 8)
  return bytes
}
const macOid = (value: string) => value.split(':').map((part) => Number.parseInt(part, 16)).join('.')
const vendorPrefix = (device: PlannedDevice) =>
  /dell/i.test(device.manufacturer) ? 'f8:bc:12' : /tp-?link/i.test(device.manufacturer) ? '50:c7:bf' : /lancom/i.test(device.manufacturer) ? '00:a0:57' : /raspberry/i.test(device.manufacturer) ? 'dc:a6:32' : '00:1a:eb'

/* ------------------------------------------------------------ transports */

class DemoSnmpSession implements SnmpSession {
  constructor(private readonly mib: Map<string, SnmpValue> | null) {}
  private fail() {
    return new Promise<never>((_, reject) => setTimeout(() => reject(new Error('RequestTimedOut: no SNMP response')), 300))
  }
  async get(oids: string[]): Promise<SnmpVarbind[]> {
    if (!this.mib) return this.fail()
    await sleep(40)
    return oids.map((oid) => ({ oid, value: this.mib!.get(oid) ?? null }))
  }
  async walk(oid: string): Promise<SnmpVarbind[]> {
    if (!this.mib) return this.fail()
    await sleep(60)
    return [...this.mib.entries()]
      .filter(([key]) => key.startsWith(`${oid}.`))
      .sort(([a], [b]) => compareOid(a, b))
      .map(([key, value]) => ({ oid: key, value }))
  }
  close() {}
}

const compareOid = (a: string, b: string) => {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const diff = (pa[index] ?? -1) - (pb[index] ?? -1)
    if (diff) return diff
  }
  return 0
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function createDemoTransports(inventory: Inventory): Transports & { network: DemoNetwork } {
  const network = new DemoNetwork(inventory)
  const byIp = (ip: string) => inventory.devices.find((device) => device.managementIp === ip)
  const pi = byIp('192.168.99.2')
  const piIp = pi?.managementIp ?? '192.168.99.2'

  const ping: PingTransport = {
    tool: 'demo',
    async ping(ips): Promise<PingResult[]> {
      await sleep(Math.min(1500, ips.length * 4))
      const t = Date.now()
      return ips.map((ip) => {
        const infra = byIp(ip)
        const alive = infra
          ? network.isOnline(infra, t)
          : ip.endsWith('.1') || !ip.startsWith('192.168.')
            ? true
            : network.clients.some((client) => client.ip === ip && client.online(t))
        return { ip, alive, rttMs: alive ? Math.round((0.3 + Math.random() * 1.5) * 100) / 100 : null }
      })
    },
  }
  const neighbors: NeighborSource = {
    available: true,
    async read(): Promise<NeighborEntry[]> {
      const t = Date.now()
      const out: NeighborEntry[] = []
      for (const device of inventory.devices)
        if (device.managementIp.startsWith('192.168.99.') && device.managementIp !== piIp && network.isOnline(device, t))
          out.push({ ip: device.managementIp, mac: network.infraMacs.get(device.id)!, interface: 'eth0', state: 'reachable' })
      return out
    },
  }
  const snmp: SnmpTransport = {
    available: true,
    open(options: SnmpSessionOptions) {
      const device = byIp(options.host)
      if (!device || !network.snmpWorks(device)) return new DemoSnmpSession(null)
      const t = Date.now()
      if (device.type === 'switch') return new DemoSnmpSession(network.switchMib(device, t))
      if (device.type === 'router') return new DemoSnmpSession(network.routerMib(device, t))
      return new DemoSnmpSession(null)
    },
  }
  const dns: DnsResolver = {
    async reverse(ip) {
      const client = network.clients.find((item) => item.ip === ip)
      return client?.hostname ? `${client.hostname}.show.local` : null
    },
    async resolve(host) {
      await sleep(30)
      return host === 'cloudflare.com' ? ['104.16.132.229', '104.16.133.229'] : ['93.184.216.34']
    },
    servers: () => ['192.168.99.1'],
  }
  return {
    ping,
    neighbors,
    snmp,
    dns,
    interfaces: () => [{ name: 'eth0', ip: piIp, cidr: `${piIp}/24` }],
    network,
  }
}
