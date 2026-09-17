import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Cable, Gauge, Layers, Search, Server, AlertTriangle, Share2, Activity, Settings } from 'lucide-react'
import { cn } from '@/ui/cn'
import { useMonitor } from '@/stores/monitorStore'
import { DeviceStatusBadge, ReachDot, VlanChip } from '@/components/status'

type Item = { id: string; kind: 'page' | 'device' | 'switch' | 'vlan'; label: string; hint?: string; to: string; extra?: React.ReactNode; keywords: string }

const pages: Item[] = [
  { id: 'p-overview', kind: 'page', label: 'Overview', to: '/overview', keywords: 'overview home dashboard' },
  { id: 'p-problems', kind: 'page', label: 'Problems & Checks', to: '/problems', keywords: 'problems warnings checks issues' },
  { id: 'p-devices', kind: 'page', label: 'Devices', to: '/devices', keywords: 'devices clients hosts' },
  { id: 'p-switches', kind: 'page', label: 'Switches & Ports', to: '/switches', keywords: 'switches ports' },
  { id: 'p-topology', kind: 'page', label: 'Topology', to: '/topology', keywords: 'topology map graph lldp' },
  { id: 'p-vlans', kind: 'page', label: 'VLANs', to: '/vlans', keywords: 'vlans subnets networks' },
  { id: 'p-events', kind: 'page', label: 'Events', to: '/events', keywords: 'events timeline history log' },
  { id: 'p-settings', kind: 'page', label: 'Settings & Inventory', to: '/settings', keywords: 'settings inventory snmp polling export import' },
]
const pageIcons: Record<string, typeof Gauge> = { 'p-overview': Gauge, 'p-problems': AlertTriangle, 'p-devices': Server, 'p-switches': Cable, 'p-topology': Share2, 'p-vlans': Layers, 'p-events': Activity, 'p-settings': Settings }

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const state = useMonitor((store) => store.state)
  const [query, setQueryState] = useState('')
  const [active, setActive] = useState(0)
  const setQuery = (value: string) => {
    setQueryState(value)
    setActive(0)
  }
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => inputRef.current?.focus(), [])

  const items = useMemo<Item[]>(() => {
    if (!state) return pages
    const devices: Item[] = state.devices
      .filter((device) => !device.macOnly)
      .map((device) => ({
        id: device.id,
        kind: 'device',
        label: device.name,
        hint: [device.primaryIp, device.primaryMac, device.location ? `${device.location.switchName} · ${device.location.port}` : null].filter(Boolean).join(' · '),
        to: `/devices/${encodeURIComponent(device.id)}`,
        extra: <DeviceStatusBadge status={device.status} />,
        keywords: [device.name, device.hostname, device.vendor, ...device.ips, ...device.macs, device.known?.owner, device.known?.category].filter(Boolean).join(' ').toLowerCase(),
      }))
    const switches: Item[] = state.switches.map((sw) => ({
      id: `sw-${sw.id}`,
      kind: 'switch',
      label: sw.name,
      hint: `${sw.managementIp} · ${sw.model}`,
      to: `/switches/${sw.id}`,
      extra: <ReachDot value={sw.reachability} />,
      keywords: `${sw.name} ${sw.managementIp} ${sw.model} ${sw.sysName ?? ''}`.toLowerCase(),
    }))
    const vlans: Item[] = state.vlans.map((vlan) => ({
      id: `vlan-${vlan.vlanId}`,
      kind: 'vlan',
      label: `VLAN ${vlan.vlanId} ${vlan.name}`,
      hint: vlan.subnet?.cidr,
      to: `/vlans?vlan=${vlan.vlanId}`,
      extra: <VlanChip vlanId={vlan.vlanId} vlans={state.vlans} showName={false} />,
      keywords: `vlan ${vlan.vlanId} ${vlan.name} ${vlan.subnet?.cidr ?? ''}`.toLowerCase(),
    }))
    return [...pages, ...switches, ...vlans, ...devices]
  }, [state])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items.filter((item) => item.kind !== 'device').slice(0, 20)
    const terms = q.split(/\s+/)
    return items.filter((item) => terms.every((term) => item.keywords.includes(term) || item.label.toLowerCase().includes(term))).slice(0, 40)
  }, [items, query])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const go = (item: Item) => {
    navigate(item.to)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[12vh] backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Search" className="w-full max-w-lg overflow-hidden rounded-lg border border-line bg-surface shadow-pop">
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search size={15} className="shrink-0 text-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActive((value) => Math.min(value + 1, results.length - 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActive((value) => Math.max(value - 1, 0))
              } else if (event.key === 'Enter') {
                const item = results[active]
                if (item) go(item)
              } else if (event.key === 'Escape') onClose()
            }}
            placeholder="Device name, IP, MAC, hostname, switch, VLAN…"
            className="h-11 w-full bg-transparent text-[14px] text-ink placeholder:text-faint focus:outline-none"
          />
          <kbd className="rounded-sm border border-line bg-surface-2 px-1 text-2xs text-faint">esc</kbd>
        </div>
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-1.5">
          {results.length === 0 && <p className="px-3 py-6 text-center text-[13px] text-muted">Nothing matches “{query}”.</p>}
          {results.map((item, index) => {
            const Icon = item.kind === 'page' ? (pageIcons[item.id] ?? Gauge) : item.kind === 'switch' ? Cable : item.kind === 'vlan' ? Layers : Server
            return (
              <button
                key={item.id}
                type="button"
                data-index={index}
                onMouseEnter={() => setActive(index)}
                onClick={() => go(item)}
                className={cn('flex w-full items-center gap-3 rounded px-2.5 py-2 text-left', index === active ? 'bg-accent-soft' : 'hover:bg-surface-2')}
              >
                <Icon size={15} className="shrink-0 text-faint" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-ink">{item.label}</span>
                  {item.hint && <span className="block truncate text-[11px] text-faint">{item.hint}</span>}
                </span>
                {item.extra}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
