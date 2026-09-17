import { describe, expect, it } from 'vitest'
import { normalizeMac, isUnicastMac, isLocallyAdministered } from '@shared/mac'
import { cidrContains, cidrHosts, parseCidr } from '@shared/ip'
import { buildPortColumns } from '@shared/portLayout'

describe('mac helpers', () => {
  it('normalises spellings', () => {
    expect(normalizeMac('F8-BC-12-00-00-01')).toBe('f8:bc:12:00:00:01')
    expect(normalizeMac('f8bc12000001')).toBe('f8:bc:12:00:00:01')
    expect(normalizeMac('nope')).toBeNull()
  })
  it('classifies', () => {
    expect(isUnicastMac('01:00:5e:00:00:fb')).toBe(false)
    expect(isUnicastMac('ff:ff:ff:ff:ff:ff')).toBe(false)
    expect(isUnicastMac('f8:bc:12:00:00:01')).toBe(true)
    expect(isLocallyAdministered('02:00:00:00:00:01')).toBe(true)
  })
})

describe('cidr helpers', () => {
  it('parses and enumerates', () => {
    const cidr = parseCidr('192.168.10.0/24')!
    expect(cidr.cidr).toBe('192.168.10.0/24')
    expect(cidrContains(cidr, '192.168.10.200')).toBe(true)
    expect(cidrContains(cidr, '192.168.11.1')).toBe(false)
    const hosts = cidrHosts(cidr)
    expect(hosts).toHaveLength(254)
    expect(hosts[0]).toBe('192.168.10.1')
    expect(hosts[253]).toBe('192.168.10.254')
  })
  it('caps large ranges', () => {
    expect(cidrHosts(parseCidr('10.0.0.0/8')!)).toHaveLength(1024)
    expect(parseCidr('300.1.1.1/24')).toBeNull()
  })
})

describe('port layout', () => {
  const ports = (count: number, sfp: number) => [
    ...Array.from({ length: count }, (_, i) => ({ number: i + 1, role: 'lan' as const })),
    ...Array.from({ length: sfp }, (_, i) => ({ number: count + i + 1, role: 'sfp' as const })),
  ]
  it('pairs odd-even top-down with an SFP block', () => {
    const columns = buildPortColumns(ports(24, 4), 'odd-even', 28)
    expect(columns).toHaveLength(12 + 1 + 2)
    const first = columns[0]!
    expect(first.kind === 'ports' && first.top?.number).toBe(1)
    expect(first.kind === 'ports' && first.bottom?.number).toBe(2)
    expect(columns[12]!.kind).toBe('spacer')
    const sfp = columns[13]!
    expect(sfp.kind === 'ports' && sfp.top?.number).toBe(25)
  })
  it('flips pairs for bottom-up', () => {
    const [first] = buildPortColumns(ports(24, 4), 'bottom-up', 28)
    expect(first!.kind === 'ports' && first!.top?.number).toBe(2)
    expect(first!.kind === 'ports' && first!.bottom?.number).toBe(1)
  })
  it('lays a router out sequentially', () => {
    const columns = buildPortColumns(ports(4, 0), 'sequential', 4)
    expect(columns.map((column) => (column.kind === 'ports' ? column.top?.number : 'x'))).toEqual([1, 2, 3, 4])
  })
})
