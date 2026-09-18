import { useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ChevronDown, ChevronLeft, ChevronRight, RefreshCw, X } from 'lucide-react'
import type { SwitchPort, SwitchState } from '@shared/types'
import { Workspace } from '@/app/Page'
import { LoadingState } from '@/components/Loading'
import { SwitchFace, FaceLegend, type PortView } from '@/components/SwitchFace'
import { Age, ReachBadge, VlanChip } from '@/components/status'
import { useMonitor } from '@/stores/monitorStore'
import { cn } from '@/ui/cn'
import { Badge, Button, IconButton, KeyValue, SectionLabel, Segmented, Spinner } from '@/ui/kit'
import { formatBps, formatBytes, formatDuration, formatSpeed } from '@/utils/format'

export function SwitchPage() {
  const { id = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const { state, requestScan, scan } = useMonitor()
  const sw = state?.switches.find((item) => item.id === id)
  const selected = params.get('port') ? Number(params.get('port')) : null
  const [view, setView] = useState<PortView>('live')
  const [filter, setFilter] = useState<'all' | 'up' | 'diffs' | 'devices'>('all')
  const [showTable, setShowTable] = useState(false)
  // The bottom sheet on phones follows the selection; it has no state of its own.
  const mobileInspector = selected !== null

  const select = (port: number | null) => {
    const next = new URLSearchParams(params)
    if (port === null || port === selected) next.delete('port')
    else next.set('port', String(port))
    setParams(next, { replace: true })
  }

  const highlight = useMemo(() => {
    if (!sw || filter === 'all') return null
    return new Set(
      sw.ports
        .filter((port) => (filter === 'up' ? port.link?.operUp : filter === 'diffs' ? port.diffs.length > 0 : port.devices.length > 0))
        .map((port) => port.number),
    )
  }, [sw, filter])

  if (!state) return <LoadingState />
  if (!sw)
    return (
      <div className="p-6">
        <Link to="/switches">
          <Button>
            <ChevronLeft size={14} /> Back to switches
          </Button>
        </Link>
      </div>
    )
  const port = selected !== null ? sw.ports.find((item) => item.number === selected) : undefined
  const busy = (scan ?? state.scan).jobs.some((job) => job.running && job.id.endsWith(`:${sw.id}`))
  const inspector = port ? <PortInspector sw={sw} port={port} onClose={() => select(null)} /> : <SwitchInspector sw={sw} />

  return (
    <Workspace
      toolbar={
        <>
          <Link to="/switches">
            <IconButton label="Back to switches" size="md">
              <ChevronLeft size={15} />
            </IconButton>
          </Link>
          <div className="min-w-0">
            <span className="flex items-center gap-2 text-[13px] font-semibold text-ink">
              {sw.name}
              <ReachBadge value={sw.reachability} />
              {sw.snmp.ok ? <Badge tone="ok">SNMP ok</Badge> : <Badge tone="danger" title={sw.snmp.lastError ?? ''}>{sw.snmp.lastError ? 'SNMP failed' : 'no SNMP yet'}</Badge>}
            </span>
            <span className="tabular block truncate text-[11px] text-faint">
              {sw.manufacturer} {sw.model} · {sw.managementIp} · {sw.portCount} ports{sw.sfpPortCount ? ` + ${sw.sfpPortCount} SFP` : ''} · {sw.layout === 'odd-even' ? 'top-down pairs' : sw.layout === 'bottom-up' ? 'bottom-up pairs' : 'sequential'}
              {sw.lastPolledAt && (
                <>
                  {' '}
                  · polled <Age iso={sw.lastPolledAt} />
                </>
              )}
            </span>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'All' },
                { value: 'up', label: 'Link up' },
                { value: 'devices', label: 'With devices' },
                { value: 'diffs', label: 'Differences' },
              ]}
            />
            <Segmented
              value={view}
              onChange={setView}
              options={[
                { value: 'live', label: 'Live' },
                { value: 'planned', label: 'Planned' },
              ]}
            />
            <Button size="sm" onClick={() => void requestScan(`switch:${sw.id}`)} disabled={busy} title="Poll this switch now">
              {busy ? <Spinner size={12} /> : <RefreshCw size={12} />}
              Poll now
            </Button>
          </div>
        </>
      }
      right={inspector}
    >
      <div className="p-3 lg:p-5">
        <div className="rounded-lg border border-line bg-canvas p-3 lg:p-5">
          {!sw.snmp.ok && (
            <p className="mb-3 rounded bg-surface-2 px-3 py-2 text-[12px] text-muted">
              {sw.reachability === 'offline'
                ? 'The switch does not answer pings — the map shows the planned configuration only.'
                : sw.snmp.lastError
                  ? `SNMP is failing (${sw.snmp.lastError}). Showing the plan; check the community in Settings.`
                  : 'Waiting for the first SNMP poll…'}
            </p>
          )}
          <SwitchFace sw={sw} vlans={state.vlans} selected={selected} onSelect={select} view={view} highlight={highlight} />
          <div className="mt-4 border-t border-[var(--canvas-grid)] pt-3">
            <FaceLegend vlans={state.vlans} view={view} />
          </div>
        </div>

        <button type="button" onClick={() => setShowTable((value) => !value)} className="mt-3 flex items-center gap-1 rounded px-1 py-1 text-[12px] text-muted hover:text-ink">
          {showTable ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {showTable ? 'Hide' : 'Show'} port table
        </button>
        {showTable && <PortTable sw={sw} selected={selected} onSelect={select} highlight={highlight} />}
      </div>

      {/* Inspector as a bottom sheet on phones/tablets. */}
      {mobileInspector && port && (
        <div className="fixed inset-x-0 bottom-0 z-40 max-h-[70vh] overflow-y-auto rounded-t-xl border-t border-line bg-surface shadow-pop lg:hidden">
          {inspector}
        </div>
      )}
    </Workspace>
  )
}

function SwitchInspector({ sw }: { sw: SwitchState }) {
  const vlans = useMonitor((store) => store.state?.vlans ?? [])
  const up = sw.ports.filter((port) => port.link?.operUp).length
  const errors = sw.ports.filter((port) => port.rates && port.rates.errorsPerMin > 0)
  return (
    <div className="space-y-4 p-3">
      <div>
        <SectionLabel>Switch</SectionLabel>
        <KeyValue
          items={[
            { label: 'System name', value: sw.sysName ?? '—', mono: true },
            { label: 'Description', value: sw.sysDescr ?? '—' },
            { label: 'Location', value: sw.sysLocation || sw.location || '—' },
            { label: 'Uptime', value: formatDuration(sw.uptimeSeconds) },
            { label: 'Ping', value: sw.rttMs !== null ? `${sw.rttMs.toFixed(1)} ms` : '—' },
            { label: 'SNMP', value: sw.snmp.ok ? `ok · ${sw.snmp.lastDurationMs ?? '?'} ms` : (sw.snmp.lastError ?? 'no data yet') },
            { label: 'Ports', value: `${up} up of ${sw.ports.filter((port) => port.link).length} polled` },
            { label: 'Port mapping', value: sw.portMappingNote ?? '—' },
          ]}
        />
      </div>
      <div>
        <SectionLabel>VLANs on this switch</SectionLabel>
        {sw.vlans.length === 0 ? (
          <p className="text-[12px] text-faint">Not read yet.</p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {sw.vlans.map((vlan) => (
              <VlanChip key={vlan.vlanId} vlanId={vlan.vlanId} vlans={vlans} />
            ))}
          </div>
        )}
        {vlans.filter((vlan) => vlan.planned && vlan.vlanId !== 90 && sw.vlans.length && !sw.vlans.some((item) => item.vlanId === vlan.vlanId)).length > 0 && (
          <p className="mt-2 text-[12px] text-warn">
            Missing: {vlans.filter((vlan) => vlan.planned && vlan.vlanId !== 90 && !sw.vlans.some((item) => item.vlanId === vlan.vlanId)).map((vlan) => `${vlan.vlanId} ${vlan.name}`).join(', ')}
          </p>
        )}
      </div>
      {errors.length > 0 && (
        <div>
          <SectionLabel>Ports with errors</SectionLabel>
          <ul className="space-y-1 text-[12px]">
            {errors.map((port) => (
              <li key={port.number} className="flex justify-between">
                <span>Port {port.number}</span>
                <span className="tabular text-warn">{port.rates!.errorsPerMin.toFixed(1)} / min</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-[12px] leading-5 text-faint">Click a port for its live details.</p>
    </div>
  )
}

function PortInspector({ sw, port, onClose }: { sw: SwitchState; port: SwitchPort; onClose: () => void }) {
  const state = useMonitor((store) => store.state)
  const vlans = state?.vlans ?? []
  const planned = port.planned
  const disc = port.discovered
  const speed = port.link?.speedMbps ?? null
  return (
    <div className="space-y-4 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[15px] font-semibold text-ink">
            Port {port.number}
            {port.ifName && <span className="mono ml-2 text-[11px] font-normal text-faint">{port.ifName}</span>}
          </p>
          <p className="text-[12px] text-muted">
            {planned?.name || (planned ? `${planned.mode}` : 'not in plan')}
            {port.ifAlias && ` · alias “${port.ifAlias}”`}
          </p>
        </div>
        <IconButton label="Close" onClick={onClose} size="md">
          <X size={15} />
        </IconButton>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {port.link ? (
          <Badge tone={port.link.operUp ? 'ok' : 'neutral'}>{port.link.operUp ? `Link up · ${formatSpeed(speed)}` : port.link.adminUp ? 'Link down' : 'Admin down'}</Badge>
        ) : (
          <Badge>No live data</Badge>
        )}
        {port.uplink && <Badge tone="accent">Uplink</Badge>}
        {port.role === 'sfp' && <Badge>SFP</Badge>}
        {port.diffs.length > 0 && <Badge tone="warn">{port.diffs.length} difference{port.diffs.length > 1 ? 's' : ''}</Badge>}
      </div>

      {port.diffs.length > 0 && (
        <div className="rounded border border-warn/40 bg-warn-soft p-2 text-[12px] leading-5 text-warn">
          <p className="mb-1 font-semibold">Differs from plan</p>
          <ul className="space-y-0.5">
            {port.diffs.map((diff, index) => (
              <li key={index}>• {describeDiff(diff, vlans)}</li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <SectionLabel>VLAN configuration</SectionLabel>
        <table className="w-full text-[12px]">
          <thead className="text-2xs uppercase tracking-wider text-faint">
            <tr>
              <th className="py-1 text-left font-semibold"></th>
              <th className="py-1 text-left font-semibold">Live</th>
              <th className="py-1 text-left font-semibold">Planned</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="py-1 text-faint">Mode</td>
              <td className="py-1 text-ink">{disc ? disc.mode : '—'}</td>
              <td className="py-1 text-muted">{planned?.mode ?? '—'}</td>
            </tr>
            <tr>
              <td className="py-1 text-faint">Untagged / PVID</td>
              <td className="py-1">{disc ? <VlanChip vlanId={disc.pvid} vlans={vlans} /> : '—'}</td>
              <td className="py-1">{planned ? <VlanChip vlanId={planned.accessVlanId ?? planned.nativeVlanId} vlans={vlans} /> : '—'}</td>
            </tr>
            <tr>
              <td className="py-1 align-top text-faint">Tagged</td>
              <td className="py-1">
                <span className="flex flex-wrap gap-1">{disc ? (disc.taggedVlanIds.length ? disc.taggedVlanIds.map((vlan) => <VlanChip key={vlan} vlanId={vlan} vlans={vlans} showName={false} />) : <span className="text-faint">none</span>) : '—'}</span>
              </td>
              <td className="py-1">
                <span className="flex flex-wrap gap-1">{planned ? (planned.taggedVlanIds.length ? planned.taggedVlanIds.map((vlan) => <VlanChip key={vlan} vlanId={vlan} vlans={vlans} showName={false} />) : <span className="text-faint">none</span>) : '—'}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div>
        <SectionLabel>Connected</SectionLabel>
        {port.devices.length === 0 && port.lldp.length === 0 && port.macs.length === 0 ? (
          <p className="text-[12px] text-faint">{port.link?.operUp ? 'Link is up but nothing has been learned on this port yet.' : 'Nothing learned on this port.'}</p>
        ) : (
          <div className="space-y-1.5">
            {port.lldp.map((neighbor, index) => (
              <div key={index} className="rounded border border-line bg-surface-2 p-2 text-[12px]">
                <p className="font-semibold text-ink">
                  {neighbor.deviceId ? (
                    <Link to={state?.switches.some((item) => item.id === neighbor.deviceId) ? `/switches/${neighbor.deviceId}` : '/overview'} className="hover:text-accent-text hover:underline">
                      {neighbor.sysName || neighbor.chassisId}
                    </Link>
                  ) : (
                    neighbor.sysName || neighbor.chassisId
                  )}
                  <span className="ml-1 font-normal text-faint">via LLDP</span>
                </p>
                <p className="text-muted">
                  their port {neighbor.portId}
                  {neighbor.portDescription && ` (${neighbor.portDescription})`}
                  {neighbor.managementIp && ` · ${neighbor.managementIp}`}
                </p>
                {neighbor.sysDescription && <p className="truncate text-faint" title={neighbor.sysDescription}>{neighbor.sysDescription}</p>}
              </div>
            ))}
            {port.devices.map((device) => (
              <Link key={device.id} to={`/devices/${encodeURIComponent(device.id)}`} className="flex items-center justify-between gap-2 rounded border border-line p-2 text-[12px] hover:bg-surface-2">
                <span className="min-w-0">
                  <span className="block truncate font-semibold text-ink">{device.name}</span>
                  <span className="mono block text-faint">{device.ip ?? 'no IP'}</span>
                </span>
                <VlanChip vlanId={device.vlanId} vlans={vlans} showName={false} />
              </Link>
            ))}
            {port.macs.length > port.devices.length && (
              <details className="text-[12px]">
                <summary className="cursor-pointer text-faint hover:text-ink">
                  {port.macs.length} MAC{port.macs.length > 1 ? 's' : ''} learned{port.uplink ? ' (uplink — devices sit behind it)' : ''}
                </summary>
                <ul className="mono mt-1 max-h-40 space-y-0.5 overflow-y-auto text-[11px] text-muted">
                  {port.macs.map((entry) => (
                    <li key={entry.mac} className="flex items-center gap-2">
                      {entry.deviceId ? (
                        <Link to={`/devices/${encodeURIComponent(entry.deviceId)}`} className="hover:text-accent-text">
                          {entry.mac}
                        </Link>
                      ) : (
                        entry.mac
                      )}
                      {entry.vlanId !== null && <VlanChip vlanId={entry.vlanId} vlans={vlans} size="xs" showName={false} />}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>

      {port.rates && (
        <div>
          <SectionLabel>Traffic</SectionLabel>
          <div className="grid grid-cols-2 gap-2 text-[12px]">
            <div className="rounded border border-line p-2">
              <p className="text-faint">In</p>
              <p className="tabular text-[14px] font-semibold text-ink">{formatBps(port.rates.inBps)}</p>
            </div>
            <div className="rounded border border-line p-2">
              <p className="text-faint">Out</p>
              <p className="tabular text-[14px] font-semibold text-ink">{formatBps(port.rates.outBps)}</p>
            </div>
          </div>
          <Sparkline history={port.rates.history} />
          <p className={cn('mt-1 text-[12px]', port.rates.errorsPerMin > 0 ? 'text-warn' : 'text-faint')}>
            {port.rates.errorsPerMin > 0 ? `${port.rates.errorsPerMin.toFixed(1)} errors/discards per minute` : 'no errors in the last interval'}
          </p>
        </div>
      )}

      {port.counters && (
        <div>
          <SectionLabel>Counters</SectionLabel>
          <KeyValue
            items={[
              { label: 'In / Out', value: `${formatBytes(port.counters.inOctets)} / ${formatBytes(port.counters.outOctets)}` },
              { label: 'Errors', value: `${port.counters.inErrors} in · ${port.counters.outErrors} out` },
              { label: 'Discards', value: `${port.counters.inDiscards} in · ${port.counters.outDiscards} out` },
              { label: 'Last change', value: port.link?.lastChangeAt ? <Age iso={port.link.lastChangeAt} /> : '—' },
              { label: 'Sampled', value: <Age iso={port.counters.sampledAt} /> },
            ]}
          />
        </div>
      )}

      {planned && (
        <div>
          <SectionLabel>Plan</SectionLabel>
          <KeyValue
            items={[
              { label: 'Label', value: planned.name || '—' },
              { label: 'Speed', value: planned.speed || '—' },
              { label: 'PoE', value: planned.poe ? 'yes' : 'no' },
            ]}
          />
        </div>
      )}
      <p className="text-[11px] text-faint">{sw.name}</p>
    </div>
  )
}

function Sparkline({ history }: { history: { t: string; inBps: number; outBps: number }[] }) {
  if (history.length < 2) return <p className="mt-2 text-[11px] text-faint">Collecting samples…</p>
  const width = 280
  const height = 40
  const max = Math.max(1, ...history.map((sample) => Math.max(sample.inBps, sample.outBps)))
  const point = (index: number, value: number) => `${(index / (history.length - 1)) * width},${height - (value / max) * (height - 4) - 2}`
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="mt-2 h-10 w-full" preserveAspectRatio="none" aria-label="Traffic history">
      <polyline fill="none" stroke="var(--accent)" strokeWidth="1.5" points={history.map((sample, index) => point(index, sample.inBps)).join(' ')} />
      <polyline fill="none" stroke="var(--ok)" strokeWidth="1.5" strokeDasharray="3 2" points={history.map((sample, index) => point(index, sample.outBps)).join(' ')} />
    </svg>
  )
}

function PortTable({ sw, selected, onSelect, highlight }: { sw: SwitchState; selected: number | null; onSelect: (port: number) => void; highlight: Set<number> | null }) {
  const vlans = useMonitor((store) => store.state?.vlans ?? [])
  const rows = highlight ? sw.ports.filter((port) => highlight.has(port.number)) : sw.ports
  return (
    <div className="mt-4 overflow-hidden rounded-lg border border-line bg-surface">
      <table className="w-full text-left text-[12px]">
        <thead className="bg-surface-2 text-2xs uppercase tracking-wider text-faint">
          <tr>
            <th className="px-3 py-2 font-semibold">Port</th>
            <th className="px-3 py-2 font-semibold">Link</th>
            <th className="px-3 py-2 font-semibold">Live VLANs</th>
            <th className="hidden px-3 py-2 font-semibold md:table-cell">Planned</th>
            <th className="px-3 py-2 font-semibold">Connected</th>
            <th className="hidden px-3 py-2 font-semibold lg:table-cell">Traffic</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((port) => (
            <tr key={port.number} onClick={() => onSelect(port.number)} className={cn('cursor-pointer hover:bg-surface-2', selected === port.number && 'bg-accent-soft')}>
              <td className="px-3 py-1.5">
                <span className="tabular font-semibold text-ink">{port.number}</span>
                {port.planned?.name && <span className="ml-1.5 text-faint">{port.planned.name}</span>}
                {port.uplink && <Badge tone="accent" className="ml-1.5">uplink</Badge>}
              </td>
              <td className="px-3 py-1.5">
                {port.link ? (
                  <span className={cn('flex items-center gap-1.5', port.link.operUp ? 'text-ink' : 'text-faint')}>
                    <span className={cn('h-1.5 w-1.5 rounded-full', port.link.operUp ? 'bg-ok' : 'bg-faint')} />
                    {port.link.operUp ? formatSpeed(port.link.speedMbps) : 'down'}
                  </span>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </td>
              <td className="px-3 py-1.5">
                {port.discovered ? (
                  <span className="flex flex-wrap items-center gap-1">
                    <VlanChip vlanId={port.discovered.pvid} vlans={vlans} showName={false} />
                    {port.discovered.taggedVlanIds.length > 0 && <span className="text-faint">+ {port.discovered.taggedVlanIds.join(', ')} tagged</span>}
                    {port.diffs.length > 0 && <Badge tone="warn">differs</Badge>}
                  </span>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </td>
              <td className="hidden px-3 py-1.5 text-muted md:table-cell">
                {port.planned ? (
                  port.planned.mode === 'trunk' || port.planned.mode === 'hybrid' ? (
                    `trunk · native ${port.planned.nativeVlanId ?? '—'} · tagged ${port.planned.taggedVlanIds.join(', ') || '—'}`
                  ) : port.planned.mode === 'access' ? (
                    <VlanChip vlanId={port.planned.accessVlanId} vlans={vlans} />
                  ) : (
                    'unused'
                  )
                ) : (
                  '—'
                )}
              </td>
              <td className="max-w-[240px] truncate px-3 py-1.5 text-ink">
                {port.lldp.length > 0 && <span className="text-accent-text">{port.lldp.map((item) => item.sysName || item.chassisId).join(', ')} </span>}
                {port.devices.map((device) => device.name).join(', ')}
                {!port.lldp.length && !port.devices.length && port.macs.length > 0 && <span className="text-faint">{port.macs.length} MACs</span>}
              </td>
              <td className="tabular hidden px-3 py-1.5 text-muted lg:table-cell">
                {port.rates ? (
                  <>
                    ↓{formatBps(port.rates.inBps)} ↑{formatBps(port.rates.outBps)}
                    {port.rates.errorsPerMin > 0 && <span className="ml-1 text-warn">⚠ {port.rates.errorsPerMin.toFixed(1)}/min</span>}
                  </>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function describeDiff(diff: SwitchPort['diffs'][number], vlans: { vlanId: number; name: string }[]): string {
  const name = (id: number | null) => (id === null ? '—' : `${id} ${vlans.find((vlan) => vlan.vlanId === id)?.name ?? ''}`.trim())
  switch (diff.kind) {
    case 'mode':
      return `Mode is ${diff.discovered}, plan says ${diff.planned}`
    case 'access-vlan':
      return `Access VLAN is ${name(diff.discovered)}, plan says ${name(diff.planned)}`
    case 'native-vlan':
      return `Native VLAN is ${name(diff.discovered)}, plan says ${name(diff.planned)}`
    case 'missing-tagged':
      return `Missing tagged VLAN ${diff.vlanIds.map(name).join(', ')}`
    case 'extra-tagged':
      return `Extra tagged VLAN ${diff.vlanIds.map(name).join(', ')} not in plan`
  }
}
