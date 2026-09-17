import { promises as dns } from 'node:dns'
import type { DnsResolver } from './transport.js'

export class SystemDnsResolver implements DnsResolver {
  async resolve(host: string): Promise<string[]> {
    return Promise.race([
      dns.resolve4(host),
      new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('DNS timeout (3 s)')), 3000)),
    ])
  }
  servers(): string[] {
    try {
      return dns.getServers()
    } catch {
      return []
    }
  }

  async reverse(ip: string): Promise<string | null> {
    try {
      const names = await Promise.race([
        dns.reverse(ip),
        new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
      ])
      const name = names[0]?.replace(/\.$/, '')
      return name && name !== ip ? name : null
    } catch {
      return null
    }
  }
}
