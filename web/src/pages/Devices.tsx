import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { EyeOff, Search, Server, SlidersHorizontal, Star, Wifi, X } from 'lucide-react'
import type { DeviceState, DeviceStatus } from '@shared/types'
import { Page } from '@/app/Page'
import { LoadingState } from '@/components/Loading'
import { Age, DeviceStatusBadge, VlanChip, deviceStatusLabel } from '@/components/status'
import { useMonitor } from '@/stores/monitorStore'
import { cn } from '@/ui/cn'
import { Badge, Button, EmptyState, Input, Segmented, Select } from '@/ui/kit'

type StatusFilter = 'all' | 'online' | DeviceStatus

export function matchesQuery(device: DeviceState, query: string) {
  if (!query) return true
  const haystack = [device.name, device.hostname, device.vendor, ...device.ips, ...device.macs, device.known?.owner, device.known?.category, device.known?.notes, device.location?.switchName, device.location?.portName]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((term) => haystack.includes(term))
}

export function DevicesPage() {
  const state = useMonitor((store) => store.state)
  const [params, setParams] = useSearchParams()
  const query = params.get('q') ?? ''
  const status = (params.get('status') as StatusFilter | null) ?? 'online'
  const vlan = params.get('vlan') ?? ''
  const sw = params.get('switch') ?? ''
  const known = params.get('known') ?? ''
  const category = params.get('category') ?? ''
  const [showMacOnly, setShowMacOnly] = useState(false)
  const [showIgnored, setShowIgnored] = useState(false)
  const [showInfra, setShowInfra] = useState(true)
  const [moreFilters, setMoreFilters] = useState(Boolean(known || category))

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }

  const categories = useMemo(() => [...new Set((state?.devices ?? []).map((device) => device.known?.category).filter((item): item is string => Boolean(item)))].sort(), [state])

  const rows = useMemo(() => {
    if (!state) return []
    return state.devices.filter((device) => {
      if (device.macOnly && !showMacOnly) return false
      if (device.known?.ignored && !showIgnored) return false
      if (device.infraId && !showInfra) return false
      if (status === 'online' ? !device.online : status !== 'all' && device.status !== status) return false
      if (vlan && String(device.vlanId) !== vlan) return false
      if (sw && device.location?.switchId !== sw) return false
      if (known === 'known' && !device.known && !device.infraId) return false
      if (known === 'unknown' && (device.known || device.infraId)) return false
      if (known === 'favorite' && !device.known?.favorite) return false
      if (category && device.known?.category !== category) return false
      return matchesQuery(device, query)
    })
  }, [state, query, status, vlan, sw, known, category, showMacOnly, showIgnored, showInfra])

  if (!state) return <LoadingState />
  const total = state.devices.filter((device) => !device.macOnly && !device.known?.ignored).length
  const macOnlyCount = state.devices.filter((device) => device.macOnly).length
  const ignoredCount = state.devices.filter((device) => device.known?.ignored).length
  const hasFilters = Boolean(query || vlan || sw || known || category || status !== 'online')

  return (
    <Page
      title="Devices"
      description={`${state.summary.devicesOnline} online · ${state.summary.devicesLocated} located · ${state.summary.devicesUnlocated} unlocated · ${total} seen in total`}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <Search size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-faint" />
          <Input value={query} onChange={(event) => set('q', event.target.value)} placeholder="Name, IP, MAC, hostname, owner…" className="pl-7" aria-label="Search devices" />
          {query && (
            <button type="button" onClick={() => set('q', '')} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-faint hover:text-ink" aria-label="Clear search">
              <X size={13} />
            </button>
          )}
        </div>
        <Segmented
          value={status}
          onChange={(value) => set('status', value === 'online' ? '' : value)}
          options={[
            { value: 'online', label: 'Online' },
            { value: 'located', label: 'Located' },
            { value: 'unlocated', label: 'Unlocated' },
            { value: 'stale', label: 'Stale' },
            { value: 'offline', label: 'Offline' },
            { value: 'all', label: 'All' },
          ]}
        />
        <Select value={vlan} onChange={(event) => set('vlan', event.target.value)} className="!w-auto" aria-label="Filter by VLAN">
          <option value="">Any VLAN</option>
          {state.vlans.map((item) => (
            <option key={item.vlanId} value={item.vlanId}>
              {item.vlanId} {item.name}
            </option>
          ))}
        </Select>
        <Select value={sw} onChange={(event) => set('switch', event.target.value)} className="!w-auto" aria-label="Filter by switch">
          <option value="">Any switch</option>
          {state.switches.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </Select>
        <Button variant={moreFilters ? 'default' : 'ghost'} size="sm" onClick={() => setMoreFilters((value) => !value)}>
          <SlidersHorizontal size={12} /> More
        </Button>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
            <X size={12} /> Reset
          </Button>
        )}
      </div>

      {moreFilters && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Select value={known} onChange={(event) => set('known', event.target.value)} className="!w-auto" aria-label="Known or unknown">
            <option value="">Known & unknown</option>
            <option value="known">Known (named)</option>
            <option value="unknown">Unknown</option>
            <option value="favorite">Favourites</option>
          </Select>
          {categories.length > 0 && (
            <Select value={category} onChange={(event) => set('category', event.target.value)} className="!w-auto" aria-label="Category">
              <option value="">Any category</option>
              {categories.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </Select>
          )}
        </div>
      )}

      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-faint">
        <span className="tabular">{rows.length} shown</span>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" checked={showInfra} onChange={(event) => setShowInfra(event.target.checked)} className="accent-[var(--accent)]" />
          include infrastructure
        </label>
        <label className="flex cursor-pointer items-center gap-1.5" title="MAC addresses seen in switch tables without any IP. Used for correlation, not shown as devices by default.">
          <input type="checkbox" checked={showMacOnly} onChange={(event) => setShowMacOnly(event.target.checked)} className="accent-[var(--accent)]" />
          show MAC-only observations ({macOnlyCount})
        </label>
        {ignoredCount > 0 && (
          <label className="flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={showIgnored} onChange={(event) => setShowIgnored(event.target.checked)} className="accent-[var(--accent)]" />
            show ignored ({ignoredCount})
          </label>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-line bg-surface">
          <EmptyState
            icon={<Server size={24} />}
            title={state.devices.length === 0 ? 'No devices discovered yet' : 'No devices match'}
            description={
              state.devices.length === 0
                ? 'Devices appear once the first ping sweep, neighbour table read or switch MAC-table poll finishes — usually within a minute.'
                : 'Try another status, clear the search or include MAC-only observations.'
            }
          />
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          <table className="w-full text-left text-[12px]">
            <thead className="bg-surface-2 text-2xs uppercase tracking-wider text-faint">
              <tr>
                <th className="px-3 py-2 font-semibold">Device</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="hidden px-3 py-2 font-semibold md:table-cell">IP</th>
                <th className="hidden px-3 py-2 font-semibold lg:table-cell">MAC</th>
                <th className="px-3 py-2 font-semibold">VLAN</th>
                <th className="hidden px-3 py-2 font-semibold sm:table-cell">Location</th>
                <th className="hidden px-3 py-2 font-semibold xl:table-cell">Seen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((device) => (
                <DeviceRow key={device.id} device={device} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  )
}

function DeviceRow({ device }: { device: DeviceState }) {
  const vlans = useMonitor((store) => store.state?.vlans ?? [])
  const href = `/devices/${encodeURIComponent(device.id)}`
  return (
    <tr className={cn('group hover:bg-surface-2', !device.online && 'opacity-70')}>
      <td className="max-w-[260px] px-3 py-2">
        <Link to={href} className="block min-w-0">
          <span className="flex items-center gap-1.5">
            {device.known?.favorite && <Star size={11} className="shrink-0 fill-warn text-warn" />}
            {device.wireless && <Wifi size={11} className="shrink-0 text-faint" />}
            {device.known?.ignored && <EyeOff size={11} className="shrink-0 text-faint" />}
            <span className="truncate font-semibold text-ink group-hover:text-accent-text">{device.name}</span>
            {device.infraId && <Badge tone="accent">infra</Badge>}
            {device.known?.category && <Badge>{device.known.category}</Badge>}
          </span>
          <span className="block truncate text-[11px] text-faint">
            {[device.hostname && device.hostname !== device.name ? device.hostname : null, device.vendor, device.known?.owner ? `owner ${device.known.owner}` : null].filter(Boolean).join(' · ') || (device.macOnly ? 'MAC only — no IP seen' : '')}
          </span>
          <span className="mono block text-[11px] text-muted md:hidden">{device.primaryIp ?? device.primaryMac ?? ''}</span>
        </Link>
      </td>
      <td className="px-3 py-2">
        <DeviceStatusBadge status={device.status} />
        {device.flags.length > 0 && (
          <span className="mt-1 block max-w-[180px] truncate text-[10px] text-warn" title={device.flags.join('\n')}>
            {device.flags[0]}
          </span>
        )}
      </td>
      <td className="mono hidden px-3 py-2 text-ink md:table-cell">
        {device.primaryIp ?? <span className="text-faint">—</span>}
        {device.ips.length > 1 && <span className="ml-1 text-faint">+{device.ips.length - 1}</span>}
      </td>
      <td className="mono hidden px-3 py-2 text-muted lg:table-cell">
        {device.primaryMac ?? <span className="text-faint">—</span>}
        {device.macs.length > 1 && <span className="ml-1 text-faint">+{device.macs.length - 1}</span>}
      </td>
      <td className="px-3 py-2">
        <VlanChip vlanId={device.vlanId} vlans={vlans} />
      </td>
      <td className="hidden px-3 py-2 sm:table-cell">
        {device.location ? (
          <Link to={`/switches/${device.location.switchId}?port=${device.location.port}`} className="text-ink hover:text-accent-text hover:underline">
            {device.location.switchName} · <span className="tabular font-semibold">{device.location.port}</span>
            {device.location.portName && <span className="text-faint"> {device.location.portName}</span>}
          </Link>
        ) : device.wireless?.ap ? (
          <span className="text-muted">Wi-Fi via {device.wireless.ap}</span>
        ) : (
          <span className="text-faint" title={device.online ? 'No switch port could be attributed.' : ''}>
            {device.online ? 'unknown port' : '—'}
          </span>
        )}
      </td>
      <td className="hidden px-3 py-2 text-muted xl:table-cell">
        <Age iso={device.lastSeenAt} />
      </td>
    </tr>
  )
}

export const statusOptions = Object.entries(deviceStatusLabel) as [DeviceStatus, string][]
