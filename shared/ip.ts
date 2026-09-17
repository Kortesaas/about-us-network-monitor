export function ipToInt(ip: string): number | null {
  const parts = ip.trim().split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

export function intToIp(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.')
}

export type Cidr = { network: number; bits: number; first: number; last: number; cidr: string }

export function parseCidr(cidr: string): Cidr | null {
  const [address, bitsText] = cidr.trim().split('/')
  if (!address) return null
  const bits = bitsText === undefined ? 32 : Number(bitsText)
  const ip = ipToInt(address)
  if (ip === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  const network = (ip & mask) >>> 0
  const size = 2 ** (32 - bits)
  return {
    network,
    bits,
    first: bits >= 31 ? network : network + 1,
    last: bits >= 31 ? network + size - 1 : network + size - 2,
    cidr: `${intToIp(network)}/${bits}`,
  }
}

export function cidrContains(cidr: Cidr, ip: string) {
  const value = ipToInt(ip)
  if (value === null) return false
  return value >= cidr.network && value < cidr.network + 2 ** (32 - cidr.bits)
}

/** All host addresses of a CIDR (capped so a typo like /8 cannot start a huge sweep). */
export function cidrHosts(cidr: Cidr, cap = 1024): string[] {
  const hosts: string[] = []
  for (let value = cidr.first; value <= cidr.last && hosts.length < cap; value += 1)
    hosts.push(intToIp(value))
  return hosts
}

export function isPrivateIpv4(ip: string) {
  const value = ipToInt(ip)
  if (value === null) return false
  const a = value >>> 24
  const b = (value >>> 16) & 255
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}
