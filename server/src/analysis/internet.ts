import type { InternetState, Reachability } from '@shared/types'
import type { Store } from '../state/store.js'

function reach(store: Store, target: string, now: number): { reachability: Reachability; rttMs: number | null; lastSeenAt: number | null } {
  const ping = store.internet.get(target)
  if (!ping) return { reachability: 'unknown', rttMs: null, lastSeenAt: null }
  if (ping.alive) return { reachability: 'online', rttMs: ping.rttMs, lastSeenAt: ping.lastAliveAt }
  if (ping.lastAliveAt === null) return { reachability: 'offline', rttMs: null, lastSeenAt: null }
  const staleWindow = Math.max(90_000, store.settings.internet.intervalSeconds * 3 * 1000)
  return { reachability: now - ping.lastAliveAt <= staleWindow ? 'stale' : 'offline', rttMs: null, lastSeenAt: ping.lastAliveAt }
}

const labelFor = (target: string) =>
  ({ '1.1.1.1': 'Cloudflare DNS', '1.0.0.1': 'Cloudflare DNS', '8.8.8.8': 'Google DNS', '8.8.4.4': 'Google DNS', '9.9.9.9': 'Quad9 DNS' })[target] ?? target

export function buildInternet(store: Store, now: number): InternetState {
  const { internet } = store.settings
  const targets = internet.targets.map((target) => {
    const result = reach(store, target, now)
    return { target, label: labelFor(target), reachability: result.reachability, rttMs: result.rttMs, lastSeenAt: result.lastSeenAt ? new Date(result.lastSeenAt).toISOString() : null }
  })
  const checked = [...store.internet.values()].map((ping) => ping.at)
  const status: Reachability = !internet.enabled
    ? 'unknown'
    : targets.some((target) => target.reachability === 'online')
      ? 'online'
      : targets.some((target) => target.reachability === 'stale')
        ? 'stale'
        : targets.every((target) => target.reachability === 'unknown')
          ? 'unknown'
          : 'offline'
  const dns = store.dnsCheck
  return {
    enabled: internet.enabled,
    status,
    targets,
    dns: {
      host: internet.dnsCheckHost,
      ok: dns?.ok ?? null,
      resolvedTo: dns?.resolvedTo ?? null,
      error: dns?.error ?? null,
      checkedAt: dns ? new Date(dns.at).toISOString() : null,
      resolvers: dns?.resolvers ?? [],
    },
    checkedAt: checked.length ? new Date(Math.max(...checked)).toISOString() : null,
  }
}
