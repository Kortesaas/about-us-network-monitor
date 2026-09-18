import { describe, expect, it } from 'vitest'
import { parseArpAn, parseIpNeigh } from '../src/poll/neighbors.js'
import { parseFping } from '../src/poll/ping.js'
import { column, portListToPorts, suffix, asMac } from '../src/poll/snmp/client.js'
import { mapInterfacesToPorts, plannedSpeedMbps } from '../src/poll/snmp/vendor.js'
import { diffPort } from '../src/analysis/switches.js'
import type { PlannedDevice } from '@shared/types'

const dell: PlannedDevice = {
  id: 'sw',
  type: 'switch',
  name: 'Dell',
  manufacturer: 'Dell',
  model: 'N1524P',
  location: '',
  rack: '',
  managementIp: '192.168.99.11',
  managementVlanId: 99,
  portCount: 24,
  sfpPortCount: 4,
  wanPortCount: 0,
  layout: 'odd-even',
  ports: [],
  position: { x: 0, y: 0 },
}

describe('neighbour table parsers', () => {
  it('parses ip neigh output with states', () => {
    const out = parseIpNeigh(`192.168.99.1 dev eth0 lladdr 00:a0:57:aa:bb:cc REACHABLE
192.168.99.11 dev eth0 lladdr f8:bc:12:00:00:01 STALE
192.168.99.50 dev eth0  FAILED
`)
    expect(out).toEqual([
      { ip: '192.168.99.1', mac: '00:a0:57:aa:bb:cc', interface: 'eth0', state: 'reachable' },
      { ip: '192.168.99.11', mac: 'f8:bc:12:00:00:01', interface: 'eth0', state: 'stale' },
    ])
  })
  it('parses macOS arp -an with unpadded octets', () => {
    const out = parseArpAn(`? (192.168.178.1) at 0:11:22:33:44:5 on en0 ifscope [ethernet]\n? (224.0.0.251) at 1:0:5e:0:0:fb on en0 ifscope permanent [ethernet]`)
    expect(out[0]).toEqual({ ip: '192.168.178.1', mac: '00:11:22:33:44:05', interface: 'en0', state: 'stale' })
  })
})

describe('ping parser', () => {
  it('parses fping alive output from this Pi', () => {
    const results = new Map([
      ['192.168.99.1', { ip: '192.168.99.1', alive: false, rttMs: null }],
      ['192.168.99.10', { ip: '192.168.99.10', alive: false, rttMs: null }],
      ['192.168.99.12', { ip: '192.168.99.12', alive: false, rttMs: null }],
    ])
    parseFping(`192.168.99.1 is alive (1.40 ms)
192.168.99.10 : 0.827
192.168.99.12 is unreachable
`, results)
    expect(results.get('192.168.99.1')).toMatchObject({ alive: true, rttMs: 1.4 })
    expect(results.get('192.168.99.10')).toMatchObject({ alive: true, rttMs: 0.827 })
    expect(results.get('192.168.99.12')).toMatchObject({ alive: false, rttMs: null })
  })
})

describe('snmp helpers', () => {
  it('decodes PortList bitmaps MSB-first', () => {
    expect(portListToPorts(Buffer.from([0b10100000, 0b00000001]))).toEqual([1, 3, 16])
  })
  it('extracts OID suffixes and columns', () => {
    expect(suffix('1.3.6.1.2.1.17.7.1.2.2.1.2.10.0.1.2.3.4.5', '1.3.6.1.2.1.17.7.1.2.2.1.2')).toEqual([10, 0, 1, 2, 3, 4, 5])
    const col = column([{ oid: '1.2.3.7', value: 1 }, { oid: '1.2.4.1', value: 2 }], '1.2.3')
    expect([...col.entries()]).toEqual([['7', 1]])
  })
  it('formats MAC buffers', () => {
    expect(asMac(Buffer.from([0xf8, 0xbc, 0x12, 0, 0, 1]))).toBe('f8:bc:12:00:00:01')
    expect(asMac(Buffer.from([1, 2]))).toBeNull()
  })
})

describe('port mapping', () => {
  it('maps Dell Gi/Te names to physical ports', () => {
    const interfaces = [
      ...Array.from({ length: 24 }, (_, i) => ({ ifIndex: i + 1, ifName: `Gi1/0/${i + 1}`, ifDescr: null, ifType: 6 })),
      ...Array.from({ length: 4 }, (_, i) => ({ ifIndex: 25 + i, ifName: `Te1/0/${i + 1}`, ifDescr: null, ifType: 6 })),
      { ifIndex: 1000, ifName: 'Vl99', ifDescr: 'VLAN 99', ifType: 53 },
      { ifIndex: 2000, ifName: 'Po1', ifDescr: 'Port-channel 1', ifType: 161 },
    ]
    const { map, note } = mapInterfacesToPorts(interfaces, dell)
    expect(map.get(1)).toBe(1)
    expect(map.get(28)).toBe(28)
    expect(map.has(1000)).toBe(false)
    expect(note).toContain('Dell')
  })
  it('maps TP-Link slot naming', () => {
    const interfaces = Array.from({ length: 28 }, (_, i) => ({ ifIndex: 49152 + i, ifName: `gigabitEthernet 1/0/${i + 1}`, ifDescr: null, ifType: 6 }))
    const { map } = mapInterfacesToPorts(interfaces, { ...dell, manufacturer: 'TP-Link' })
    expect(map.get(49152 + 27)).toBe(28)
  })
  it('falls back to ifIndex order when names do not parse', () => {
    const interfaces = Array.from({ length: 28 }, (_, i) => ({ ifIndex: i + 5, ifName: `weird-${String.fromCharCode(97 + (i % 26))}`, ifDescr: null, ifType: 6 }))
    const { map, note } = mapInterfacesToPorts(interfaces, dell)
    expect(map.get(5)).toBe(1)
    expect(note).toContain('ifIndex order')
  })
  it('parses planned speeds', () => {
    expect(plannedSpeedMbps('1 Gbps')).toBe(1000)
    expect(plannedSpeedMbps('100 Mbps')).toBe(100)
    expect(plannedSpeedMbps('')).toBeNull()
  })
})

describe('planned vs discovered diffs', () => {
  const trunk = { number: 23, role: 'lan' as const, name: 'TRUNK', mode: 'trunk' as const, accessVlanId: null, nativeVlanId: 99, taggedVlanIds: [10, 20, 30, 40, 99], poe: false, speed: '1 Gbps' }
  it('reports missing and extra tagged VLANs and wrong native', () => {
    const diffs = diffPort(trunk, { pvid: 1, untaggedVlanIds: [1], taggedVlanIds: [10, 20, 30, 90], mode: 'trunk' })
    expect(diffs).toEqual([
      { kind: 'native-vlan', planned: 99, discovered: 1 },
      { kind: 'missing-tagged', vlanIds: [40, 99] },
      { kind: 'extra-tagged', vlanIds: [90] },
    ])
  })
  it('accepts the native VLAN as carrying the planned tag', () => {
    expect(diffPort(trunk, { pvid: 99, untaggedVlanIds: [99], taggedVlanIds: [10, 20, 30, 40], mode: 'trunk' })).toEqual([])
  })
  it('flags a wrong access VLAN', () => {
    const access = { ...trunk, mode: 'access' as const, accessVlanId: 20, nativeVlanId: null, taggedVlanIds: [] }
    expect(diffPort(access, { pvid: 10, untaggedVlanIds: [10], taggedVlanIds: [], mode: 'access' })).toEqual([{ kind: 'access-vlan', planned: 20, discovered: 10 }])
  })
  it('ignores unknown discovery and unused plan', () => {
    expect(diffPort(trunk, { pvid: null, untaggedVlanIds: [], taggedVlanIds: [], mode: 'unknown' })).toEqual([])
    expect(diffPort({ ...trunk, mode: 'unused' }, { pvid: 1, untaggedVlanIds: [1], taggedVlanIds: [], mode: 'access' })).toEqual([])
  })
})

describe('router WAN interface detection', async () => {
  const { isWanInterfaceName, counterRate } = await import('../src/poll/snmp/routerPoller.js')
  it('picks the logical WAN links, not modem channels or LAN ports', () => {
    expect(['DSL-1', 'VDSL', 'WAN-2', 'PPPOE-1', 'LTE-1'].every((name) => isWanInterfaceName(name, []))).toBe(true)
    expect(['DSL-CH-1', 'XDSL-1', 'ETH-4', 'LAN-1', 'WLC-TUNNEL-1', 'BRG-1'].some((name) => isWanInterfaceName(name, []))).toBe(false)
    expect(isWanInterfaceName('ETH-4', ['eth-4'])).toBe(true)
    expect(isWanInterfaceName('DSL-1', ['ETH-4'])).toBe(false)
  })
  it('turns HC counters into bytes per second and ignores wraps', () => {
    expect(counterRate(0, 1000, 10_000, 6000)).toBe(500)
    expect(counterRate(0, 6000, 10_000, 1000)).toBeNull()
    expect(counterRate(null, null, 10_000, 1000)).toBeNull()
  })
})
