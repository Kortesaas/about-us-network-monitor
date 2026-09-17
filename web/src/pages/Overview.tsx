import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowRight, Cable, ChevronDown, ChevronRight, Globe, Server, Wifi } from 'lucide-react'
import type { InternetState, Reachability, Summary } from '@shared/types'
import { Page } from '@/app/Page'
import { LoadingState } from '@/components/Loading'
import { InfraCard, UnusedInfraRow } from '@/components/InfraCard'
import { ProblemRow } from '@/components/ProblemCard'
import { EventRow } from '@/components/EventRow'
import { Age, ReachDot, reachLabel } from '@/components/status'
import { useMonitor } from '@/stores/monitorStore'
import { cn } from '@/ui/cn'
import { EmptyState, Panel, type Tone } from '@/ui/kit'

export function OverviewPage() {
  const { state, scan } = useMonitor()
  const [showUnused, setShowUnused] = useState(false)
  if (!state) return <LoadingState />
  const { summary, internet } = state
  const problems = state.problems.filter((problem) => problem.severity !== 'info')
  const used = [...state.infra].filter((item) => item.inUse).sort((a, b) => order(a.type) - order(b.type))
  const unused = state.infra.filter((item) => !item.inUse)
  const scanStatus = scan ?? state.scan
  const tone = { ok: 'bg-ok', degraded: 'bg-warn', critical: 'bg-danger', unknown: 'bg-faint' }[summary.health]

  return (
    <Page
      title={
        <span className="flex items-center gap-2.5">
          <span className={cn('h-3 w-3 rounded-full', tone, summary.health === 'ok' && 'pulse-ok')} />
          {healthTitle(summary)}
        </span>
      }
      description={
        <span>
          updated <Age iso={state.generatedAt} />
          {scanStatus.busy && <span className="text-accent-text"> · {scanStatus.activity}</span>}
        </span>
      }
      dense
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Tile to="/overview#infra" label="Infrastructure" value={`${summary.infraOnline}/${summary.infraTotal}`} detail={summary.switchesSnmpOk < summary.switchesTotal ? `${summary.switchesTotal - summary.switchesSnmpOk} switch without SNMP` : 'online'} tone={summary.infraOnline < summary.infraTotal ? 'danger' : 'ok'} icon={<Wifi size={13} />} />
        <Tile to="/devices" label="Devices" value={summary.devicesOnline} detail={summary.devicesUnlocated ? `${summary.devicesUnlocated} without known port` : `${summary.devicesLocated} located`} icon={<Server size={13} />} />
        <Tile to="/switches" label="Ports up" value={summary.portsTotal ? summary.portsUp : '—'} detail={summary.portsTotal ? `of ${summary.portsTotal}` : 'no SNMP yet'} icon={<Cable size={13} />} />
        <Tile
          to="/problems"
          label="Problems"
          value={problems.length}
          detail={problems.length ? `${summary.problemsCritical} critical · ${summary.problemsWarning} warn` : 'none'}
          tone={summary.problemsCritical ? 'danger' : summary.problemsWarning ? 'warn' : 'ok'}
          icon={<AlertTriangle size={13} />}
        />
        <Tile
          to="/overview#internet"
          label="Internet"
          value={internet.enabled ? reachLabel[internet.status] : 'off'}
          detail={internet.enabled ? (internet.dns.ok === null ? 'checking DNS…' : internet.dns.ok ? 'DNS ok' : 'DNS failing') : 'check disabled'}
          tone={internetTone(internet)}
          icon={<Globe size={13} />}
        />
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-[1.4fr_1fr]">
        <section id="infra" className="min-w-0">
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
            <div className="grid gap-1.5 lg:grid-cols-2">
              {used.map((item) => (
                <InfraCard key={item.id} item={item} />
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
                <div className="mt-1 grid gap-1.5 lg:grid-cols-2">
                  {unused.map((item) => (
                    <UnusedInfraRow key={item.id} item={item} />
                  ))}
                </div>
              )}
            </div>
          )}

          <div id="internet" className="mt-3">
            <h3 className="mb-1.5 text-[12px] font-semibold uppercase tracking-wider text-faint">Internet & DNS</h3>
            <InternetPanel internet={internet} />
          </div>
        </section>

        <div className="min-w-0 space-y-3">
          <Panel
            title={problems.length ? `Problems (${problems.length})` : 'Problems'}
            bodyClassName="p-1"
            actions={
              <Link to="/problems" className="text-[12px] text-accent-text hover:underline">
                {state.problems.length > problems.length ? `All ${state.problems.length}` : 'Details'}
              </Link>
            }
          >
            {problems.length === 0 ? (
              <p className="px-2 py-2 text-[12px] text-muted">Everything in use answers and matches the plan.</p>
            ) : (
              <>
                {problems.slice(0, 6).map((problem) => (
                  <ProblemRow key={problem.id} problem={problem} />
                ))}
                {problems.length > 6 && (
                  <Link to="/problems" className="block rounded px-2 py-1 text-center text-[11px] text-accent-text hover:bg-surface-2">
                    {problems.length - 6} more…
                  </Link>
                )}
              </>
            )}
          </Panel>

          <Panel
            title="Recent changes"
            bodyClassName="p-1"
            actions={
              <Link to="/events" className="text-[12px] text-accent-text hover:underline">
                Timeline
              </Link>
            }
          >
            {state.events.length === 0 ? <p className="px-2 py-2 text-[12px] text-muted">No events yet.</p> : state.events.slice(0, 7).map((event) => <EventRow key={event.id} event={event} />)}
          </Panel>
        </div>
      </div>

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

function InternetPanel({ internet }: { internet: InternetState }) {
  if (!internet.enabled) return <p className="rounded-md border border-line bg-surface px-2.5 py-2 text-[12px] text-muted">Internet check is disabled in Settings → Discovery.</p>
  const rows: { key: string; label: string; sub: string; reachability: Reachability; value: string }[] = internet.targets.map((target) => ({
    key: target.target,
    label: target.label,
    sub: target.target,
    reachability: target.reachability,
    value: target.reachability === 'online' && target.rttMs !== null ? `${target.rttMs.toFixed(0)} ms` : target.reachability === 'unknown' ? 'checking…' : reachLabel[target.reachability],
  }))
  const dns = internet.dns
  rows.push({
    key: 'dns',
    label: 'DNS resolution',
    sub: dns.host + (dns.resolvers.length ? ` via ${dns.resolvers.join(', ')}` : ''),
    reachability: dns.ok === null ? 'unknown' : dns.ok ? 'online' : 'offline',
    value: dns.ok === null ? 'checking…' : dns.ok ? (dns.resolvedTo ?? 'ok') : (dns.error ?? 'failed'),
  })
  return (
    <div className="grid gap-1.5 sm:grid-cols-3">
      {rows.map((row) => (
        <div key={row.key} className={cn('flex h-10 items-center gap-2 rounded-md border bg-surface px-2', row.reachability === 'offline' ? 'border-danger/50 bg-danger-soft/30' : row.reachability === 'stale' ? 'border-warn/50' : 'border-line')}>
          <ReachDot value={row.reachability} pulse />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px] font-semibold text-ink">{row.label}</span>
            <span className="mono block truncate text-[10px] text-faint">{row.sub}</span>
          </span>
          <span className={cn('mono shrink-0 text-[11px]', row.reachability === 'online' ? 'text-ok' : row.reachability === 'offline' ? 'text-danger' : 'text-muted')} title={row.value}>
            {row.value.length > 18 ? `${row.value.slice(0, 18)}…` : row.value}
          </span>
        </div>
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
