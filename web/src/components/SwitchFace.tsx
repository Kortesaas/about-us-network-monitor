import { useEffect, useRef } from 'react'
import { AlertTriangle, ArrowUpFromLine, Link2 } from 'lucide-react'
import type { SwitchPort, SwitchState, VlanState } from '@shared/types'
import { buildPortColumns, rowsForLayout } from '@shared/portLayout'
import { cn } from '@/ui/cn'
import { readableTextColor } from '@/utils/color'
import { formatBps } from '@/utils/format'

const TRUNK_FILL = '#0b0f1a'
const TRUNK_TEXT = '#facc15'
const UNKNOWN_FILL = '#475569'
const UNUSED_FILL = '#334155'

export type PortView = 'live' | 'planned'

/** Colour and label of a port cell: what it *is* right now (live) or what the plan says. */
export function portAppearance(port: SwitchPort, vlans: VlanState[], view: PortView) {
  const colorOf = (vlanId: number | null) => vlans.find((vlan) => vlan.vlanId === vlanId)?.color ?? UNKNOWN_FILL
  const nameOf = (vlanId: number | null) => vlans.find((vlan) => vlan.vlanId === vlanId)?.name ?? (vlanId !== null ? `VLAN ${vlanId}` : '')
  const planned = port.planned
  const discovered = port.discovered
  if (view === 'live' && discovered && discovered.mode !== 'unknown') {
    if (discovered.mode === 'trunk')
      return { background: TRUNK_FILL, foreground: TRUNK_TEXT, label: planned?.name || 'TRUNK', stripes: discovered.taggedVlanIds.map(colorOf), mode: 'trunk' as const }
    return { background: colorOf(discovered.pvid), foreground: readableTextColor(colorOf(discovered.pvid)), label: nameOf(discovered.pvid), stripes: [], mode: 'access' as const }
  }
  if (planned) {
    if (planned.mode === 'unused') return { background: UNUSED_FILL, foreground: '#cbd5e1', label: 'unused', stripes: [], mode: 'unused' as const }
    if (planned.mode === 'trunk' || planned.mode === 'hybrid')
      return { background: TRUNK_FILL, foreground: TRUNK_TEXT, label: planned.name || 'TRUNK', stripes: planned.taggedVlanIds.map(colorOf), mode: 'trunk' as const }
    const vlan = planned.accessVlanId ?? planned.nativeVlanId
    return { background: colorOf(vlan), foreground: readableTextColor(colorOf(vlan)), label: planned.name || nameOf(vlan), stripes: [], mode: 'access' as const }
  }
  return { background: UNKNOWN_FILL, foreground: '#ffffff', label: '', stripes: [], mode: 'unknown' as const }
}

export function SwitchFace({
  sw,
  vlans,
  selected,
  onSelect,
  view = 'live',
  compact = false,
  highlight,
}: {
  sw: SwitchState
  vlans: VlanState[]
  selected?: number | null
  onSelect?: (port: number) => void
  view?: PortView
  compact?: boolean
  /** Ports to emphasise (e.g. those carrying a VLAN); others are dimmed. */
  highlight?: Set<number> | null
}) {
  const total = sw.portCount + sw.sfpPortCount
  const columns = buildPortColumns(sw.ports, sw.layout, total)
  const rows = rowsForLayout(sw.layout)
  const live = sw.snmp.ok && sw.ports.some((port) => port.link)
  return (
    <div className={cn('flex gap-1 overflow-x-auto pb-1', compact ? 'gap-[3px]' : 'gap-1.5')} role="group" aria-label={`${sw.name} ports`}>
      {columns.map((column) =>
        column.kind === 'spacer' ? (
          <div key={column.index} aria-hidden="true" className={cn('flex shrink-0 items-stretch justify-center', compact ? 'w-2' : 'w-4')}>
            <span className="w-px bg-[var(--canvas-grid)]" />
          </div>
        ) : (
          <div key={column.index} className={cn('flex shrink-0 flex-col', compact ? 'w-[26px] gap-[3px]' : 'w-[52px] gap-1.5 sm:w-[58px]')}>
            {(rows === 2 ? [column.top, column.bottom] : [column.top]).map((port, rowIndex) =>
              port ? (
                <PortCell
                  key={port.number}
                  port={port}
                  vlans={vlans}
                  view={view}
                  compact={compact}
                  live={live}
                  selected={selected === port.number}
                  dimmed={highlight ? !highlight.has(port.number) : false}
                  onClick={onSelect ? () => onSelect(port.number) : undefined}
                />
              ) : (
                <div key={`${column.index}-${rowIndex}`} className={cn('rounded-sm border border-dashed border-[var(--canvas-grid)]', compact ? 'h-[26px]' : 'h-[54px]')} />
              ),
            )}
          </div>
        ),
      )}
    </div>
  )
}

function PortCell({
  port,
  vlans,
  view,
  compact,
  live,
  selected,
  dimmed,
  onClick,
}: {
  port: SwitchPort
  vlans: VlanState[]
  view: PortView
  compact: boolean
  live: boolean
  selected: boolean
  dimmed: boolean
  onClick?: () => void
}) {
  const look = portAppearance(port, vlans, view)
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  }, [selected])
  const up = port.link?.operUp ?? null
  const down = live && up === false
  const device = port.devices[0]
  const hasDiff = port.diffs.length > 0
  const speed = port.link?.speedMbps ?? null
  const rate = port.rates ? Math.max(port.rates.inBps, port.rates.outBps) : null
  const utilisation = rate !== null && speed ? Math.min(1, rate / (speed * 1_000_000)) : null
  // Log scale so a 2 Mb/s DMX stream on a gigabit port is still visible.
  const bar = utilisation !== null && utilisation > 0 ? Math.min(1, Math.max(0.06, Math.log10(1 + utilisation * 999) / 3)) : 0
  const label = view === 'live' && device ? device.name : look.label
  const title = [
    `Port ${port.number}${port.ifName ? ` (${port.ifName})` : ''}`,
    port.planned?.name ? `Planned: ${port.planned.name}` : null,
    port.link ? `Link ${up ? `up${speed ? ` ${speed >= 1000 ? `${speed / 1000} Gbit/s` : `${speed} Mbit/s`}` : ''}` : 'down'}` : 'No live data',
    port.devices.length ? `Devices: ${port.devices.map((item) => item.name).join(', ')}` : null,
    port.lldp.length ? `LLDP: ${port.lldp.map((item) => item.sysName || item.chassisId).join(', ')}` : null,
    port.rates ? `↓ ${formatBps(port.rates.inBps)} ↑ ${formatBps(port.rates.outBps)}` : null,
    hasDiff ? `${port.diffs.length} difference(s) from plan` : null,
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-label={`Port ${port.number}`}
      title={title}
      className={cn(
        'relative w-full overflow-hidden rounded-sm border text-center transition-all',
        compact ? 'h-[26px]' : 'h-[54px]',
        selected ? 'border-white ring-2 ring-white ring-offset-2 ring-offset-[var(--canvas)]' : hasDiff ? 'border-amber-400' : 'border-transparent',
        onClick && 'hover:brightness-110',
        (down || dimmed) && !selected && 'opacity-40 saturate-50',
        port.role === 'sfp' && 'ring-1 ring-inset ring-white/20',
      )}
      style={{ background: look.background, color: look.foreground }}
    >
      {live && up !== null && (
        <span
          className={cn('absolute right-1 top-1 h-1.5 w-1.5 rounded-full', up ? 'bg-[#3ecf8e] shadow-[0_0_4px_#3ecf8e]' : 'bg-black/40 ring-1 ring-white/30')}
          aria-hidden="true"
        />
      )}
      {!compact && port.uplink && <ArrowUpFromLine size={9} className="absolute left-1 top-1 opacity-80" aria-label="Uplink" />}
      {!compact && !port.uplink && port.lldp.length > 0 && <Link2 size={9} className="absolute left-1 top-1 opacity-80" aria-label="LLDP neighbour" />}
      {hasDiff && (
        <span className={cn('absolute grid place-items-center rounded-full bg-amber-400 text-black', compact ? 'left-0.5 top-0.5 h-2.5 w-2.5' : 'bottom-1 right-1 h-3.5 w-3.5')}>
          <AlertTriangle size={compact ? 6 : 8} />
        </span>
      )}
      <span className={cn('tabular block font-bold leading-none', compact ? 'pt-[6px] text-[11px]' : 'pt-1.5 text-[15px]')}>{port.number}</span>
      {!compact && (
        <span className={cn('mt-0.5 block truncate px-1 text-[8px] font-bold uppercase leading-tight tracking-wide', device && view === 'live' ? 'normal-case opacity-100' : 'opacity-90')}>{label}</span>
      )}
      {!compact && look.stripes.length > 0 && (
        <span className="absolute inset-x-0 bottom-0 flex h-[3px]">
          {look.stripes.map((color, index) => (
            <span key={index} className="flex-1" style={{ background: color }} />
          ))}
        </span>
      )}
      {!compact && bar > 0 && !look.stripes.length && (
        <span className="absolute bottom-0 left-0 h-[3px] bg-white/80" style={{ width: `${bar * 100}%` }} aria-hidden="true" />
      )}
    </button>
  )
}

export function FaceLegend({ vlans, view }: { vlans: VlanState[]; view: PortView }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-slate-400">
      {vlans
        .filter((vlan) => vlan.planned)
        .map((vlan) => (
          <span key={vlan.vlanId} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: vlan.color }} />
            {vlan.vlanId} {vlan.name}
          </span>
        ))}
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-[2px] bg-[#0b0f1a] ring-1 ring-slate-600" />
        Trunk
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-[2px] bg-[#334155]" />
        Unused
      </span>
      {view === 'live' && (
        <>
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-[#3ecf8e]" /> link up
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-[2px] bg-slate-500 opacity-40" /> link down
          </span>
          <span className="flex items-center gap-1.5">
            <span className="grid h-3 w-3 place-items-center rounded-full bg-amber-400 text-black">
              <AlertTriangle size={7} />
            </span>
            differs from plan
          </span>
          <span className="flex items-center gap-1.5">
            <ArrowUpFromLine size={10} /> uplink
          </span>
        </>
      )}
    </div>
  )
}
