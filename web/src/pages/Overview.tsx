import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowRight, Cable, ChevronDown, ChevronRight, Globe, Server } from 'lucide-react'
import type { InternetState, Reachability, Summary } from '@shared/types'
import { Page } from '@/app/Page'
import { LoadingState } from '@/components/Loading'
import { InfraCard, UnusedInfraRow } from '@/components/InfraCard'
import { ProblemRow } from '@/components/ProblemCard'
import { EventRow } from '@/components/EventRow'
import { Age, ReachDot, reachLabel } from '@/components/status'
import { RATE_COLORS, RateChart } from '@/components/RateChart'
import { isDarkTheme, useThemeStore } from '@/stores/themeStore'
import { formatBps } from '@/utils/format'
import { useMonitor } from '@/stores/monitorStore'
import { cn } from '@/ui/cn'
import { EmptyState, Panel, type Tone } from '@/ui/kit'

export function OverviewPage() {
  const { state, scan } = useMonitor()
  const theme = useThemeStore((store) => store.theme)
  const dark = isDarkTheme(theme)
  const [showUnused, setShowUnused] = useState(false)
  if (!state) return <LoadingState />
  const { summary, internet, traffic } = state
  const problems = state.problems.filter((problem) => problem.severity !== 'info')
  const used = [...state.infra].filter((item) => item.inUse).sort((a, b) => order(a.type) - order(b.type) || a.name.localeCompare(b.name))
  const unused = state.infra.filter((item) => !item.inUse)
  const scanStatus = scan ?? state.scan
  const tone = { ok: 'bg-ok', degraded: 'bg-warn', critical: 'bg-danger', unknown: 'bg-faint' }[summary.health]
  const wan = traffic.wan
  const wanSeries = traffic.series.find((item) => item.kind === 'wan') ?? null
  const colors = dark ? RATE_COLORS.dark : RATE_COLORS.light
  const wanPoints = (wanSeries?.samples ?? []).map((sample) => ({ t: Date.parse(sample.t), values: [sample.inBps * 8, sample.outBps * 8] }))
  const groups = [
    { label: 'Router', items: used.filter((item) => item.type === 'router') },
    { label: 'Switches', items: used.filter((item) => item.type === 'switch') },
    { label: 'Access points', items: used.filter((item) => item.type === 'access-point') },
    { label: 'Other', items: used.filter((item) => !['router', 'switch', 'access-point'].includes(item.type)) },
  ].filter((group) => group.items.length)
  const wifiClients = state.wlan.clients.length

  return (
    <Page
      title={
        <span className="flex items-center gap-2.5">
          <span className={cn('h-3 w-3 rounded-full', tone, summary.health === 'ok' && 'pulse-ok')} />
          {healthTitle(summary)}
        </span>
      }
      description={
        // One line, fixed height: whatever is happening right now replaces the previous message instead of adding to it.
        <span className="block h-5 truncate whitespace-nowrap">
          {scanStatus.busy && scanStatus.activity ? (
            <span className="text-accent-text">{scanStatus.activity}</span>
          ) : (
            <>
              updated <Age iso={state.generatedAt} />
            </>
          )}
        </span>
      }
    >
      {/* One row of answers: is the infrastructure up, is the internet up, what is wrong, how many devices. */}
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Tile
          to="/problems"
          label="Problems"
          value={problems.length}
          detail={problems.length ? `${summary.problemsCritical} critical · ${summary.problemsWarning} warning` : 'everything matches the plan'}
          tone={summary.problemsCritical ? 'danger' : summary.problemsWarning ? 'warn' : 'ok'}
          icon={<AlertTriangle size={13} />}
        />
        <Tile
          to="/overview#infra"
          label="Infrastructure"
          value={`${summary.infraOnline}/${summary.infraTotal}`}
          detail={summary.infraOnline < summary.infraTotal ? `${summary.infraTotal - summary.infraOnline} not answering` : summary.switchesSnmpOk < summary.switchesTotal ? `${summary.switchesTotal - summary.switchesSnmpOk} switch without SNMP` : 'all online'}
          tone={summary.infraOnline < summary.infraTotal ? 'danger' : 'ok'}
          icon={<Cable size={13} />}
        />
        <Tile
          to="/overview#internet"
          label="Internet"
          value={internet.enabled ? reachLabel[internet.status] : 'off'}
          detail={wan && wan.inBps !== null ? `↓ ${formatBps(wan.inBps * 8)} · ↑ ${formatBps((wan.outBps ?? 0) * 8)}` : internet.enabled ? (internet.dns.ok === false ? 'DNS failing' : 'DNS ok') : 'check disabled'}
          tone={internetTone(internet)}
          icon={<Globe size={13} />}
        />
        <Tile to="/devices" label="Devices" value={summary.devicesOnline} detail={`${wifiClients} on Wi-Fi · ${summary.devicesUnlocated ? `${summary.devicesUnlocated} unlocated` : 'all located'}`} icon={<Server size={13} />} />
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-[1fr_1fr]">
        <Panel
          title={problems.length ? `Problems (${problems.length})` : 'Problems'}
          bodyClassName="p-1"
          actions={
            <Link to="/problems" className="text-[12px] text-accent-text hover:underline">
              All
            </Link>
          }
        >
          {problems.length === 0 ? (
            <p className="px-2 py-3 text-[12px] text-muted">Everything in use answers and matches the plan.</p>
          ) : (
            <>
              {problems.slice(0, 5).map((problem) => (
                <ProblemRow key={problem.id} problem={problem} />
              ))}
              {problems.length > 5 && (
                <Link to="/problems" className="block rounded px-2 py-1 text-center text-[11px] text-accent-text hover:bg-surface-2">
                  {problems.length - 5} more…
                </Link>
              )}
            </>
          )}
        </Panel>

        <Panel
          title={
            <span id="internet" className="flex items-center gap-2">
              Internet
              {wan && <span className="font-normal text-faint">{wan.routerName}{wan.interfaces.length ? ` · ${wan.interfaces.map((iface) => iface.name).join(', ')}` : ''}</span>}
            </span>
          }
          bodyClassName="p-3"
          actions={
            <Link to="/traffic" className="text-[12px] text-accent-text hover:underline">
              Traffic
            </Link>
          }
        >
          <InternetLine internet={internet} />
          {wan ? (
            <RateChart className="mt-2" dark={dark} height={110} series={[{ label: 'download', color: colors[0] }, { label: 'upload', color: colors[1] }]} points={wanPoints} emptyText="Collecting WAN samples…" />
          ) : (
            <p className="mt-2 text-[11px] text-faint">WAN throughput appears once the router answers SNMP.</p>
          )}
        </Panel>
      </div>

      <section id="infra" className="mt-3">
        <div className="mb-1.5 flex items-center justify-between">
          <h3 className="text-[12px] font-semibold uppercase tracking-wider text-faint">Infrastructure in use</h3>
          <Link to="/switches" className="flex items-center gap-1 text-[12px] text-accent-text hover:underline">
            Port maps <ArrowRight size={12} />
          </Link>
        </div>
        {used.length === 0 ? (
          <Panel>
            <EmptyState
              icon={<Server size={24} />}
              title={state.infra.length === 0 ? 'No planned infrastructure' : 'Nothing in use yet'}
              description={state.infra.length === 0 ? 'Upload the planner JSON in Settings → Inventory.' : 'Planned devices join automatically as soon as they answer a ping — or pick them below.'}
            />
          </Panel>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {groups.map((group) => (
              <div key={group.label} className="min-w-0">
                <p className="mb-1 text-[11px] font-medium text-faint">
                  {group.label} <span className="tabular">{group.items.length}</span>
                </p>
                <div className="space-y-1.5">
                  {group.items.map((item) => (
                    <InfraCard key={item.id} item={item} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        {unused.length > 0 && (
          <div className="mt-1.5">
            <button type="button" onClick={() => setShowUnused((value) => !value)} className="flex items-center gap-1 rounded px-1 py-1 text-[11px] text-faint hover:text-ink">
              {showUnused ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {unused.length} planned device{unused.length === 1 ? '' : 's'} not in use
            </button>
            {showUnused && (
              <div className="mt-1 grid gap-1.5 md:grid-cols-2 xl:grid-cols-4">
                {unused.map((item) => (
                  <UnusedInfraRow key={item.id} item={item} />
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      <Panel
        className="mt-3"
        title="Recent changes"
        bodyClassName="p-1"
        actions={
          <Link to="/events" className="text-[12px] text-accent-text hover:underline">
            Timeline
          </Link>
        }
      >
        {state.events.length === 0 ? (
          <p className="px-2 py-2 text-[12px] text-muted">No events yet.</p>
        ) : (
          <div className="grid md:grid-cols-2">
            {state.events.slice(0, 6).map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </div>
        )}
      </Panel>

      <p className="mt-3 text-[11px] text-faint">
        {state.backend.hostname} · v{state.backend.version} · {state.backend.mode} ·{' '}
        <Link to="/settings#polling" className="hover:text-ink hover:underline">
          {scanStatus.jobs.length} jobs
        </Link>
        {scanStatus.jobs.some((job) => job.lastError) && <span className="text-warn"> · {scanStatus.jobs.filter((job) => job.lastError).length} failing</span>}
      </p>
    </Page>
  )
}

/** The three internet checks on one line: ping targets with RTT and DNS. */
function InternetLine({ internet }: { internet: InternetState }) {
  if (!internet.enabled) return <p className="text-[12px] text-muted">Internet check is disabled in Settings → Discovery.</p>
  const dns = internet.dns
  const items: { key: string; label: string; reachability: Reachability; value: string }[] = internet.targets.map((target) => ({
    key: target.target,
    label: target.label,
    reachability: target.reachability,
    value: target.reachability === 'online' && target.rttMs !== null ? `${target.rttMs.toFixed(0)} ms` : target.reachability === 'unknown' ? '…' : reachLabel[target.reachability],
  }))
  items.push({ key: 'dns', label: 'DNS', reachability: dns.ok === null ? 'unknown' : dns.ok ? 'online' : 'offline', value: dns.ok === null ? '…' : dns.ok ? 'ok' : (dns.error ?? 'failed') })
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
      {items.map((item) => (
        <span key={item.key} className="flex items-center gap-1.5" title={item.key}>
          <ReachDot value={item.reachability} pulse />
          <span className="text-ink">{item.label}</span>
          <span className={cn('mono', item.reachability === 'online' ? 'text-muted' : item.reachability === 'offline' ? 'text-danger' : 'text-faint')}>{item.value.length > 24 ? `${item.value.slice(0, 24)}…` : item.value}</span>
        </span>
      ))}
    </div>
  )
}

function Tile({ to, label, value, detail, tone = 'neutral', icon }: { to: string; label: string; value: React.ReactNode; detail: string; tone?: Tone; icon: React.ReactNode }) {
  const color: Record<Tone, string> = { neutral: 'text-ink', accent: 'text-accent-text', ok: 'text-ok', warn: 'text-warn', danger: 'text-danger' }
  return (
    <Link to={to} className="flex items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2 transition-colors hover:border-line-strong">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted">
          {label}
          <span className="text-faint">{icon}</span>
        </span>
        <span className={cn('tabular block text-xl font-semibold leading-tight', color[tone])}>{value}</span>
        <span className="block truncate text-[11px] text-faint">{detail}</span>
      </span>
    </Link>
  )
}

const order = (type: string) => ({ router: 0, switch: 1, 'access-point': 2, computer: 3, server: 3 })[type] ?? 4

function healthTitle(summary: Summary) {
  if (summary.health === 'critical') return `${summary.problemsCritical} critical problem${summary.problemsCritical === 1 ? '' : 's'}`
  if (summary.health === 'degraded') return 'Needs attention'
  if (summary.health === 'ok') return 'Network is healthy'
  return 'Waiting for data'
}

function internetTone(internet: InternetState): Tone {
  if (!internet.enabled || internet.status === 'unknown') return 'neutral'
  if (internet.status === 'offline') return 'danger'
  if (internet.status === 'stale' || internet.dns.ok === false) return 'warn'
  return 'ok'
}
