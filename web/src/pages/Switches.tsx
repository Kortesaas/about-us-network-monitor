import { Link } from 'react-router-dom'
import { ArrowRight, Cable } from 'lucide-react'
import { Page } from '@/app/Page'
import { LoadingState } from '@/components/Loading'
import { SwitchFace, FaceLegend } from '@/components/SwitchFace'
import { Age, ReachBadge } from '@/components/status'
import { useMonitor } from '@/stores/monitorStore'
import { Badge, EmptyState, Panel } from '@/ui/kit'
import { formatDuration } from '@/utils/format'

export function SwitchesPage() {
  const state = useMonitor((store) => store.state)
  if (!state) return <LoadingState />
  if (state.switches.length === 0)
    return (
      <Page title="Switches & Ports">
        <Panel>
          <EmptyState icon={<Cable size={24} />} title="No switches in the inventory" description="Upload the planner JSON in Settings → Inventory. Switches with a management IP are polled over SNMP." />
        </Panel>
      </Page>
    )
  const inUse = new Set(state.infra.filter((item) => item.inUse).map((item) => item.id))
  const shown = state.switches.filter((sw) => inUse.has(sw.id))
  const hidden = state.switches.filter((sw) => !inUse.has(sw.id))
  return (
    <Page title="Switches & Ports" description="Live port maps. Green LED = link up, amber marker = differs from the plan. Click a switch to inspect ports.">
      <div className="space-y-4">
        {shown.length === 0 && (
          <Panel>
            <EmptyState icon={<Cable size={24} />} title="No switch in use yet" description="Switches join the setup automatically when they answer a ping, or add them under Settings → Setup." />
          </Panel>
        )}
        {shown.map((sw) => {
          const up = sw.ports.filter((port) => port.link?.operUp).length
          const diffs = sw.ports.filter((port) => port.diffs.length).length
          const located = sw.ports.reduce((sum, port) => sum + port.devices.length, 0)
          return (
            <Panel
              key={sw.id}
              title={
                <Link to={`/switches/${sw.id}`} className="flex items-center gap-2 hover:text-accent-text">
                  {sw.name}
                  <span className="mono font-normal text-faint">{sw.managementIp}</span>
                  <ArrowRight size={13} className="text-faint" />
                </Link>
              }
              actions={
                <div className="flex flex-wrap items-center gap-1.5">
                  {sw.snmp.ok ? (
                    <Badge tone="ok" title={`Polled ${sw.lastPolledAt}`}>
                      {up} ports up · {located} devices
                    </Badge>
                  ) : (
                    <Badge tone={sw.reachability === 'offline' ? 'danger' : 'warn'} title={sw.snmp.lastError ?? undefined}>
                      {sw.reachability === 'offline' ? 'unreachable' : sw.snmp.lastError ? 'SNMP failed' : 'waiting for SNMP'}
                    </Badge>
                  )}
                  {diffs > 0 && <Badge tone="warn">{diffs} differ from plan</Badge>}
                  <ReachBadge value={sw.reachability} />
                </div>
              }
              bodyClassName="p-0"
            >
              <div className="bg-canvas p-3">
                <Link to={`/switches/${sw.id}`} className="block">
                  <SwitchFace sw={sw} vlans={state.vlans} />
                </Link>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-[11px] text-faint">
                <span>
                  {sw.manufacturer} {sw.model}
                </span>
                {sw.location && <span>{sw.location}</span>}
                {sw.sysName && <span className="mono">{sw.sysName}</span>}
                {sw.uptimeSeconds !== null && <span>up {formatDuration(sw.uptimeSeconds)}</span>}
                {sw.lastPolledAt && (
                  <span>
                    polled <Age iso={sw.lastPolledAt} />
                  </span>
                )}
                {!sw.snmp.ok && sw.snmp.lastError && <span className="text-danger">{sw.snmp.lastError}</span>}
              </div>
            </Panel>
          )
        })}
        <div className="rounded-lg border border-line bg-canvas p-3">
          <FaceLegend vlans={state.vlans} view="live" />
        </div>
        {hidden.length > 0 && (
          <p className="text-[12px] text-faint">
            Not in use: {hidden.map((sw) => sw.name).join(', ')} —{' '}
            <Link to="/settings#setup" className="text-accent-text hover:underline">
              Setup
            </Link>
          </p>
        )}
      </div>
    </Page>
  )
}
