import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// The IEEE OUI registry (oui-data): { "DCA632": "Raspberry Pi Trading Ltd\n<address>", … }.
let database: Record<string, string> | null = null
try {
  database = require('oui-data') as Record<string, string>
} catch {
  database = null
}

/** A few vendors that matter on a show network, in case the OUI database is missing. */
const fallback: Record<string, string> = {
  'b8:27:eb': 'Raspberry Pi',
  'dc:a6:32': 'Raspberry Pi',
  'e4:5f:01': 'Raspberry Pi',
  'd8:3a:dd': 'Raspberry Pi',
  '00:a0:57': 'LANCOM Systems',
  '00:1a:8c': 'Dante / Audinate',
  '00:1d:c1': 'Audinate',
}

const cache = new Map<string, string | null>()

/** Vendor name for a normalised MAC; the OUI database's multi-line address block is cut to the company name. */
export function vendorForMac(mac: string | null): string | null {
  if (!mac) return null
  const prefix = mac.slice(0, 8)
  if (cache.has(prefix)) return cache.get(prefix)!
  let vendor: string | null = fallback[prefix] ?? null
  if (!vendor && database) {
    const raw = database[prefix.replace(/:/g, '').toUpperCase()]
    vendor = raw ? (raw.split('\n')[0] ?? '').trim() || null : null
  }
  vendor = vendor ? tidy(vendor) : null
  cache.set(prefix, vendor)
  return vendor
}

function tidy(name: string) {
  return name
    .replace(/,?\s*(inc\.?|ltd\.?|llc|gmbh|co\.,? ltd\.?|corp\.?|corporation|limited|s\.a\.|ag|b\.v\.)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}
