import type { DeviceStatus, ProblemSeverity, Reachability, Summary, VlanState } from '@shared/types'
import { cn } from '@/ui/cn'
import { Badge, type Tone } from '@/ui/kit'
import { readableTextColor } from '@/utils/color'
import { formatAge } from '@/utils/format'
import { useMonitor } from '@/stores/monitorStore'

export const reachTone: Record<Reachability, Tone> = { online: 'ok', stale: 'warn', offline: 'danger', unknown: 'neutral' }
export const reachLabel: Record<Reachability, string> = { online: 'Online', stale: 'Stale', offline: 'Offline', unknown: 'Unknown' }

const dotColor: Record<Reachability, string> = {
  online: 'bg-ok',
  stale: 'bg-warn',
  offline: 'bg-danger',
  unknown: 'bg-faint',
}

export function ReachDot({ value, pulse, className }: { value: Reachability; pulse?: boolean; className?: string }) {
  return (
    <span
      aria-label={reachLabel[value]}
      className={cn('inline-block h-2 w-2 shrink-0 rounded-full', dotColor[value], pulse && value === 'online' && 'pulse-ok', className)}
    />
  )
}

export function ReachBadge({ value, label }: { value: Reachability; label?: string }) {
  return (
    <Badge tone={reachTone[value]}>
      <ReachDot value={value} />
      {label ?? reachLabel[value]}
    </Badge>
  )
}

export const deviceStatusTone: Record<DeviceStatus, Tone> = {
  located: 'ok',
  relocating: 'accent',
  unlocated: 'warn',
  stale: 'warn',
  offline: 'danger',
}
export const deviceStatusLabel: Record<DeviceStatus, string> = {
  located: 'Located',
  relocating: 'Relocating',
  unlocated: 'Unlocated',
  stale: 'Stale',
  offline: 'Offline',
}
export const deviceStatusHint: Record<DeviceStatus, string> = {
  located: 'Online and its switch port is known.',
  relocating: 'Online and recently moved to another port or switch.',
  unlocated: 'Online, but no switch port could be attributed (not in any MAC table, or only seen via an uplink).',
  stale: 'Not confirmed recently — may have just gone away.',
  offline: 'Not seen for a long time.',
}

export function DeviceStatusBadge({ status }: { status: DeviceStatus }) {
  return (
    <Badge tone={deviceStatusTone[status]} title={deviceStatusHint[status]}>
      {deviceStatusLabel[status]}
    </Badge>
  )
}

export const severityTone: Record<ProblemSeverity | 'ok', Tone> = { critical: 'danger', warning: 'warn', info: 'accent', ok: 'ok' }
export const severityLabel: Record<ProblemSeverity, string> = { critical: 'Critical', warning: 'Warning', info: 'Info' }

export function SeverityBadge({ severity }: { severity: ProblemSeverity }) {
  return <Badge tone={severityTone[severity]}>{severityLabel[severity]}</Badge>
}

export function HealthBadge({ health, summary }: { health: Summary['health']; summary?: Summary }) {
  const map: Record<Summary['health'], { tone: Tone; label: string }> = {
    ok: { tone: 'ok', label: 'All good' },
    degraded: { tone: 'warn', label: summary ? `${summary.problemsWarning} warnings` : 'Degraded' },
    critical: { tone: 'danger', label: summary ? `${summary.problemsCritical} critical` : 'Critical' },
    unknown: { tone: 'neutral', label: 'No data' },
  }
  const item = map[health]
  return <Badge tone={item.tone}>{item.label}</Badge>
}

/** Colour-coded VLAN identity, same colours as the planner and the rack labels. */
export function VlanChip({ vlanId, vlans, size = 'sm', showName = true, className }: { vlanId: number | null; vlans: VlanState[]; size?: 'xs' | 'sm'; showName?: boolean; className?: string }) {
  if (vlanId === null) return <span className={cn('text-faint', className)}>—</span>
  const vlan = vlans.find((item) => item.vlanId === vlanId)
  const color = vlan?.color ?? '#64748b'
  return (
    <span
      title={vlan ? `VLAN ${vlan.vlanId} ${vlan.name}` : `VLAN ${vlanId}`}
      className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-sm font-semibold', size === 'xs' ? 'px-1 text-[9px] leading-[14px]' : 'px-1.5 text-2xs leading-4', className)}
      style={{ background: color, color: readableTextColor(color) }}
    >
      <span className="tabular">{vlanId}</span>
      {showName && vlan && <span className="uppercase tracking-wide">{vlan.name}</span>}
    </span>
  )
}

/** "12s ago", ticking with the store clock. */
export function Age({ iso, className, prefix }: { iso: string | null | undefined; className?: string; prefix?: string }) {
  const now = useMonitor((store) => store.now)
  return (
    <span className={cn('tabular whitespace-nowrap', className)} title={iso ? new Date(iso).toLocaleString() : undefined}>
      {prefix}
      {formatAge(iso, now)}
    </span>
  )
}

/** Big number card used on the overview; whole card is a link when `to` is set. */
export function Stat({ label, value, detail, tone = 'neutral', icon }: { label: string; value: React.ReactNode; detail?: React.ReactNode; tone?: Tone; icon?: React.ReactNode }) {
  const valueColor: Record<Tone, string> = { neutral: 'text-ink', accent: 'text-accent-text', ok: 'text-ok', warn: 'text-warn', danger: 'text-danger' }
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[12px] font-medium text-muted">{label}</span>
        {icon && <span className="text-faint">{icon}</span>}
      </div>
      <p className={cn('tabular mt-1.5 text-2xl font-semibold leading-none', valueColor[tone])}>{value}</p>
      {detail && <p className="mt-1.5 truncate text-[11px] text-faint">{detail}</p>}
    </div>
  )
}
