import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Cable, Cpu, EyeOff, Plus, Radio, Router, Server, Wifi } from 'lucide-react'
import type { InfraState } from '@shared/types'
import { api } from '@/api/client'
import { cn } from '@/ui/cn'
import { Badge, Spinner } from '@/ui/kit'
import { Age, ReachDot, reachLabel } from '@/components/status'
import { useMonitor } from '@/stores/monitorStore'
import { formatDuration } from '@/utils/format'

const icons: Record<InfraState['type'], typeof Server> = {
  switch: Cable,
  router: Router,
  'access-point': Wifi,
  server: Server,
  computer: Cpu,
  media: Radio,
  custom: Server,
}

export function infraHref(item: InfraState) {
  return item.type === 'switch' ? `/switches/${item.id}` : `/devices?q=${encodeURIComponent(item.managementIp)}`
}

/** One line per device: what it is, whether it answers, and the one detail that matters right now. */
export function InfraCard({ item }: { item: InfraState }) {
  const Icon = icons[item.type]
  const reload = useMonitor((store) => store.reload)
  const [busy, setBusy] = useState(false)
  const offline = item.reachability === 'offline'
  const stale = item.reachability === 'stale'
  const snmpFailed = item.snmp?.enabled && !item.snmp.ok && Boolean(item.snmp.lastError)
  const detail = !item.monitored
    ? 'outside the monitored subnets'
    : offline
      ? item.lastSeenAt
        ? 'last answer '
        : 'never answered'
      : snmpFailed
        ? `SNMP failed`
        : [item.uptimeSeconds !== null ? `up ${formatDuration(item.uptimeSeconds)}` : null, item.locatedAt ? `on ${item.locatedAt.switchName} · ${item.locatedAt.port}` : null, item.wireless ? `${item.wireless.clients} clients` : null]
            .filter(Boolean)
            .join(' · ')

  const setUse = async (inUse: boolean) => {
    setBusy(true)
    try {
      await api.setInUse(item.id, inUse)
      await reload()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={cn(
        'group flex h-10 items-center gap-2 rounded-md border bg-surface px-2 transition-colors',
        offline ? 'border-danger/50 bg-danger-soft/30' : stale || snmpFailed ? 'border-warn/50' : 'border-line hover:border-line-strong',
      )}
    >
      <span className={cn('grid h-6 w-6 shrink-0 place-items-center rounded', item.reachability === 'online' ? 'bg-ok-soft text-ok' : offline ? 'bg-danger-soft text-danger' : 'bg-surface-2 text-muted')}>
        <Icon size={13} />
      </span>
      <Link to={infraHref(item)} className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="max-w-[60%] shrink-0 truncate text-[12px] font-semibold text-ink group-hover:text-accent-text">{item.name}</span>
        <span className="mono hidden shrink-0 text-[11px] text-faint 2xl:inline">{item.managementIp}</span>
        <span className={cn('hidden min-w-0 flex-1 truncate text-[11px] sm:inline', offline ? 'text-danger' : snmpFailed ? 'text-warn' : 'text-faint')} title={`${item.managementIp} · ${detail}`}>
          {detail}
          {offline && item.lastSeenAt && <Age iso={item.lastSeenAt} />}
        </span>
      </Link>
      {item.monitored ? (
        <span className={cn('flex shrink-0 items-center gap-1.5 text-[11px] font-medium', item.reachability === 'online' ? 'text-ok' : offline ? 'text-danger' : stale ? 'text-warn' : 'text-faint')}>
          <ReachDot value={item.reachability} pulse />
          {reachLabel[item.reachability]}
        </span>
      ) : (
        <Badge>not monitored</Badge>
      )}
      {offline && (
        <button
          type="button"
          onClick={() => void setUse(false)}
          disabled={busy}
          title="Not part of this setup — stop monitoring it and clear the problem"
          className="grid h-6 w-6 shrink-0 place-items-center rounded text-faint opacity-0 transition-opacity hover:bg-surface-2 hover:text-ink focus:opacity-100 group-hover:opacity-100"
        >
          {busy ? <Spinner size={12} /> : <EyeOff size={13} />}
        </button>
      )}
    </div>
  )
}

/** Planned devices that are not part of the current setup: one quiet row each, with a way to add them. */
export function UnusedInfraRow({ item }: { item: InfraState }) {
  const Icon = icons[item.type]
  const reload = useMonitor((store) => store.reload)
  const [busy, setBusy] = useState(false)
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-dashed border-line px-2.5 py-1.5 text-muted">
      <Icon size={14} className="shrink-0 text-faint" />
      <span className="min-w-0 flex-1 truncate text-[12px]">
        {item.name} <span className="mono text-[11px] text-faint">{item.managementIp}</span>
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          try {
            await api.setInUse(item.id, true)
            await reload()
          } finally {
            setBusy(false)
          }
        }}
        className="flex h-6 shrink-0 items-center gap-1 rounded border border-line px-1.5 text-[11px] font-medium text-muted hover:border-line-strong hover:text-ink"
      >
        {busy ? <Spinner size={11} /> : <Plus size={11} />}
        Use
      </button>
    </div>
  )
}
