import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Layers } from 'lucide-react'
import { Page } from '@/app/Page'
import { LoadingState } from '@/components/Loading'
import { SwitchFace } from '@/components/SwitchFace'
import { Age, ReachBadge, VlanChip } from '@/components/status'
import { useMonitor } from '@/stores/monitorStore'
import { cn } from '@/ui/cn'
import { Badge, EmptyState, KeyValue, Panel } from '@/ui/kit'

export function VlansPage() {
  const state = useMonitor((store) => store.state)
  const [params, setParams] = useSearchParams()
  const selectedId = params.get('vlan') ? Number(params.get('vlan')) : null
  const selected = state?.vlans.find((vlan) => vlan.vlanId === selectedId) ?? state?.vlans.find((vlan) => vlan.planned) ?? state?.vlans[0] ?? null
  const members = useMemo(() => (state && selected ? state.devices.filter((device) => device.vlanId === selected.vlanId && !device.macOnly && !device.known?.ignored) : []), [state, selected])
  if (!state) return <LoadingState />
  if (state.vlans.length === 0)
    return (
      <Page title="VLANs">
        <Panel>
          <EmptyState icon={<Layers size={24} />} title="No VLANs" description="Planned VLANs come from the inventory JSON; discovered ones from the switches' VLAN tables." />
        </Panel>
      </Page>
    )
  // Only switches in this setup: planned-but-unused hardware would just show empty planned faces.
  const inUse = new Set(state.infra.filter((item) => item.inUse).map((item) => item.id))
  const switches = state.switches.filter((sw) => inUse.has(sw.id))
  const anySnmp = switches.some((sw) => sw.snmp.ok)

  return (
    <Page title="VLANs" description="Planned VLANs, checked against what the switches carry.">
      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <div className="space-y-1.5">
          {state.vlans.map((vlan) => {
            // Only VLANs with a planned subnet are expected everywhere; WAN passthrough VLANs live on a few ports.
            const missing = anySnmp && vlan.planned && vlan.subnet ? vlan.presentOn.filter((item) => !item.present && switches.find((sw) => sw.id === item.switchId)?.snmp.ok).length : 0
            const active = selected?.vlanId === vlan.vlanId
            return (
              <button
                key={vlan.vlanId}
                type="button"
                onClick={() => setParams({ vlan: String(vlan.vlanId) }, { replace: true })}
                className={cn('flex w-full items-center gap-3 rounded-lg border p-2.5 text-left transition-colors', active ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:border-line-strong')}
              >
                <span className="h-8 w-1.5 shrink-0 rounded-full" style={{ background: vlan.color }} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                    <span className="tabular">{vlan.vlanId}</span> {vlan.name}
                    {!vlan.planned && <Badge tone="neutral">discovered</Badge>}
                  </span>
                  <span className="mono block truncate text-[11px] text-faint">{vlan.subnet?.cidr ?? 'no subnet planned'}</span>
                </span>
                <span className="flex flex-col items-end gap-1 text-[11px]">
                  <span className="tabular text-ink">{vlan.onlineDeviceCount} online</span>
                  {missing > 0 && <Badge tone="warn">missing on {missing}</Badge>}
                </span>
              </button>
            )
          })}
        </div>

        {selected && (
          <div className="min-w-0 space-y-4">
            <Panel
              title={
                <span className="flex items-center gap-2">
                  <VlanChip vlanId={selected.vlanId} vlans={state.vlans} />
                  <span className="font-normal text-muted">{selected.description}</span>
                </span>
              }
              bodyClassName="p-3"
            >
              <div className="grid gap-4 md:grid-cols-2">
                <KeyValue
                  items={[
                    { label: 'Subnet', value: selected.subnet?.cidr ?? '—', mono: true },
                    {
                      label: 'Gateway',
                      value: selected.subnet?.gateway ? (
                        <span className="flex items-center gap-2">
                          <span className="mono">{selected.subnet.gateway}</span>
                          {selected.gatewayReachability && <ReachBadge value={selected.gatewayReachability} />}
                          {selected.gatewayRttMs !== null && <span className="text-faint">{selected.gatewayRttMs.toFixed(1)} ms</span>}
                        </span>
                      ) : (
                        '—'
                      ),
                    },
                    { label: 'DHCP', value: selected.subnet?.dhcpStart ? `${selected.subnet.dhcpStart} – ${selected.subnet.dhcpEnd}` : '—', mono: true },
                    { label: 'DNS', value: selected.subnet?.dns.join(', ') || '—', mono: true },
                  ]}
                />
                <div>
                  <p className="mb-1 text-2xs font-semibold uppercase tracking-wider text-faint">Configured on</p>
                  <ul className="space-y-1 text-[12px]">
                    {selected.presentOn.filter((item) => inUse.has(item.switchId)).map((item) => {
                      const sw = switches.find((candidate) => candidate.id === item.switchId)
                      const known = sw?.snmp.ok && (sw.vlans.length > 0)
                      return (
                        <li key={item.switchId} className="flex items-center gap-2">
                          <span className={cn('h-1.5 w-1.5 rounded-full', !known ? 'bg-faint' : item.present ? 'bg-ok' : 'bg-danger')} />
                          <Link to={`/switches/${item.switchId}`} className="text-ink hover:text-accent-text hover:underline">
                            {item.switchName}
                          </Link>
                          <span className="text-faint">{!known ? 'no SNMP data' : item.present ? 'present' : 'missing'}</span>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              </div>
            </Panel>

            <Panel title={`Ports carrying VLAN ${selected.vlanId}`} bodyClassName="p-0">
              {switches.map((sw) => {
                const ports = new Set(selected.ports.filter((port) => port.switchId === sw.id).map((port) => port.port))
                if (ports.size === 0) return null
                const tagged = selected.ports.filter((port) => port.switchId === sw.id && port.tagged).length
                return (
                  <div key={sw.id} className="border-b border-line last:border-b-0">
                    <div className="flex items-center gap-2 px-3 pt-2 text-[12px]">
                      <Link to={`/switches/${sw.id}`} className="font-semibold text-ink hover:text-accent-text">
                        {sw.name}
                      </Link>
                      <span className="text-faint">
                        {ports.size} ports · {tagged} tagged · {ports.size - tagged} untagged{!sw.snmp.ok ? ' · planned' : ''}
                      </span>
                    </div>
                    <div className="bg-canvas p-3">
                      <Link to={`/switches/${sw.id}`}>
                        <SwitchFace sw={sw} vlans={state.vlans} highlight={ports} compact />
                      </Link>
                    </div>
                  </div>
                )
              })}
              {selected.ports.length === 0 && <p className="px-3 py-4 text-[12px] text-muted">No port carries this VLAN.</p>}
            </Panel>

            <Panel title={`Devices (${members.length})`} bodyClassName="p-0">
              {members.length === 0 ? (
                <p className="px-3 py-4 text-[12px] text-muted">No devices seen in this VLAN.</p>
              ) : (
                <table className="w-full text-left text-[12px]">
                  <thead className="bg-surface-2 text-2xs uppercase tracking-wider text-faint">
                    <tr>
                      <th className="px-3 py-2 font-semibold">Device</th>
                      <th className="px-3 py-2 font-semibold">IP</th>
                      <th className="hidden px-3 py-2 font-semibold sm:table-cell">Location</th>
                      <th className="px-3 py-2 font-semibold">Seen</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {members.map((device) => (
                      <tr key={device.id} className={cn('hover:bg-surface-2', !device.online && 'opacity-60')}>
                        <td className="px-3 py-1.5">
                          <Link to={`/devices/${encodeURIComponent(device.id)}`} className="font-semibold text-ink hover:text-accent-text">
                            {device.name}
                          </Link>
                        </td>
                        <td className="mono px-3 py-1.5 text-muted">{device.primaryIp ?? '—'}</td>
                        <td className="hidden px-3 py-1.5 text-muted sm:table-cell">{device.location ? `${device.location.switchName} · ${device.location.port}` : device.online ? 'unlocated' : '—'}</td>
                        <td className="px-3 py-1.5 text-muted">
                          <Age iso={device.lastSeenAt} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
          </div>
        )}
      </div>
    </Page>
  )
}
