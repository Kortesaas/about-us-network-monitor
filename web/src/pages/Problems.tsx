import { useMemo, useState } from 'react'
import { CheckCircle2, ShieldCheck } from 'lucide-react'
import type { ProblemSeverity } from '@shared/types'
import { Page } from '@/app/Page'
import { LoadingState } from '@/components/Loading'
import { ProblemCard } from '@/components/ProblemCard'
import { useMonitor } from '@/stores/monitorStore'
import { EmptyState, Panel, Segmented, Select } from '@/ui/kit'

const CHECKS: { code: string; label: string }[] = [
  { code: 'infra-offline', label: 'Router / switch / AP unreachable' },
  { code: 'infra-stale', label: 'Infrastructure missed pings' },
  { code: 'snmp-failed', label: 'SNMP failing or stale' },
  { code: 'gateway-unreachable', label: 'VLAN gateway unreachable' },
  { code: 'internet-down', label: 'No internet connection' },
  { code: 'dns-failed', label: 'DNS not resolving' },
  { code: 'vlan-missing', label: 'Planned VLAN missing on a switch' },
  { code: 'port-mode-mismatch', label: 'Access/trunk mode differs from plan' },
  { code: 'access-vlan-mismatch', label: 'Wrong access VLAN' },
  { code: 'native-vlan-mismatch', label: 'Wrong native VLAN on trunk' },
  { code: 'trunk-missing-vlan', label: 'VLAN missing on trunk' },
  { code: 'trunk-extra-vlan', label: 'Unplanned VLAN on trunk' },
  { code: 'ap-trunk-mismatch', label: 'AP trunk mismatch' },
  { code: 'ap-port-down', label: 'AP port down' },
  { code: 'uplink-down', label: 'Planned trunk / uplink down' },
  { code: 'lldp-mismatch', label: 'Switch/router on an access port' },
  { code: 'port-errors', label: 'Port errors increasing' },
  { code: 'link-speed-low', label: 'Link slower than planned' },
  { code: 'duplicate-ip', label: 'Duplicate IP address' },
  { code: 'device-vlan-mismatch', label: 'Device IP does not match its port VLAN' },
  { code: 'device-offline', label: 'Known device offline' },
  { code: 'device-moved', label: 'Device changed port' },
  { code: 'unknown-on-management', label: 'Unknown device on management VLAN' },
]

export function ProblemsPage() {
  const state = useMonitor((store) => store.state)
  const [severity, setSeverity] = useState<'all' | ProblemSeverity>('all')
  const [code, setCode] = useState('')
  const rows = useMemo(() => (state?.problems ?? []).filter((problem) => (severity === 'all' || problem.severity === severity) && (!code || problem.code === code)), [state, severity, code])
  if (!state) return <LoadingState />
  const counts = { critical: state.summary.problemsCritical, warning: state.summary.problemsWarning, info: state.summary.problemsInfo }
  const activeCodes = new Set(state.problems.map((problem) => problem.code))

  return (
    <Page
      title="Problems & Checks"
      description="What is wrong, why it matters, what to do. Only devices in use are checked."
      actions={
        <>
          <Segmented
            value={severity}
            onChange={setSeverity}
            options={[
              { value: 'all', label: `All ${state.problems.length}` },
              { value: 'critical', label: `Critical ${counts.critical}` },
              { value: 'warning', label: `Warnings ${counts.warning}` },
              { value: 'info', label: `Info ${counts.info}` },
            ]}
          />
          <Select value={code} onChange={(event) => setCode(event.target.value)} className="!w-auto" aria-label="Filter by check">
            <option value="">Every check</option>
            {CHECKS.filter((check) => activeCodes.has(check.code)).map((check) => (
              <option key={check.code} value={check.code}>
                {check.label}
              </option>
            ))}
          </Select>
        </>
      }
    >
      <div className="grid gap-4 xl:grid-cols-[1fr_300px]">
        <div className="space-y-2">
          {rows.length === 0 ? (
            <Panel>
              <EmptyState icon={<CheckCircle2 size={26} className="text-ok" />} title={state.problems.length === 0 ? 'All checks pass' : 'Nothing in this filter'} description={state.problems.length === 0 ? 'The live network matches the plan and every monitored device answers.' : 'Try another severity or check.'} />
            </Panel>
          ) : (
            rows.map((problem) => <ProblemCard key={problem.id} problem={problem} expanded />)
          )}
        </div>
        <Panel title="Checks" bodyClassName="p-2">
          <ul className="space-y-0.5 text-[12px]">
            {CHECKS.map((check) => {
              const count = state.problems.filter((problem) => problem.code === check.code).length
              return (
                <li key={check.code}>
                  <button type="button" onClick={() => setCode(code === check.code ? '' : check.code)} className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-surface-2">
                    {count ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" /> : <ShieldCheck size={12} className="shrink-0 text-ok" />}
                    <span className="min-w-0 flex-1 truncate text-ink">{check.label}</span>
                    <span className="tabular text-faint">{count || ''}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </Panel>
      </div>
    </Page>
  )
}
