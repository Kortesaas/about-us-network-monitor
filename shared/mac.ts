/** Normalises any common MAC spelling to `aa:bb:cc:dd:ee:ff`; null when it is not a MAC. */
export function normalizeMac(input: string | null | undefined): string | null {
  if (!input) return null
  const hex = input.replace(/[^0-9a-fA-F]/g, '').toLowerCase()
  if (hex.length !== 12) return null
  return hex.match(/.{2}/g)!.join(':')
}

/** Broadcast, multicast and locally-administered "random" MACs are not devices. */
export function isUnicastMac(mac: string) {
  const first = Number.parseInt(mac.slice(0, 2), 16)
  if (Number.isNaN(first)) return false
  if (mac === 'ff:ff:ff:ff:ff:ff' || mac === '00:00:00:00:00:00') return false
  return (first & 0x01) === 0
}

/** Private / randomised MACs (phones with MAC privacy) — keep them, but say so. */
export function isLocallyAdministered(mac: string) {
  const first = Number.parseInt(mac.slice(0, 2), 16)
  return !Number.isNaN(first) && (first & 0x02) !== 0
}
