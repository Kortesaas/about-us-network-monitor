import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Download, RefreshCw, RotateCcw, Save, Upload } from 'lucide-react'
import type { PublicSettings, SnmpTarget } from '@shared/types'
import { Page } from '@/app/Page'
import { LoadingState } from '@/components/Loading'
import { Age, ReachBadge } from '@/components/status'
import { api } from '@/api/client'
import { useMonitor } from '@/stores/monitorStore'
import { cn } from '@/ui/cn'
import { Badge, Button, Field, Input, Panel, Segmented, Select, Spinner, Toggle } from '@/ui/kit'

type Tab = 'setup' | 'polling' | 'snmp' | 'discovery' | 'inventory' | 'integrations' | 'backup'

export function SettingsPage() {
  const { state, scan, reload } = useMonitor()
  const location = useLocation()
  const [tab, setTab] = useState<Tab>((location.hash.replace('#', '') as Tab) || 'setup')
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [draft, setDraft] = useState<PublicSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)

  useEffect(() => {
    void api.settings().then((value) => {
      setSettings(value)
      setDraft(value)
    })
  }, [])
  useEffect(() => {
    if (!message) return
    const timer = setTimeout(() => setMessage(null), 5000)
    return () => clearTimeout(timer)
  }, [message])

  if (!state || !draft || !settings) return <LoadingState />
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings)
  const update = (patch: Partial<PublicSettings>) => setDraft({ ...draft, ...patch })

  const save = async () => {
    setSaving(true)
    try {
      const saved = await api.saveSettings(draft)
      setSettings(saved)
      setDraft(saved)
      setMessage({ tone: 'ok', text: 'Saved — polling reconfigured.' })
      void reload()
    } catch (error) {
      setMessage({ tone: 'danger', text: error instanceof Error ? error.message : 'Save failed' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Page
      title="Settings & Inventory"
      description="Everything runs on the Pi. Read-only: the monitor never writes to a device."
      actions={
        <>
          {message && <span className={cn('text-[12px]', message.tone === 'ok' ? 'text-ok' : 'text-danger')}>{message.text}</span>}
          <Button variant="primary" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? <Spinner size={12} /> : <Save size={13} />}
            Save changes
          </Button>
        </>
      }
    >
      <Segmented
        className="mb-4 w-full max-w-3xl"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'setup', label: 'Setup' },
          { value: 'polling', label: 'Polling' },
          { value: 'snmp', label: 'SNMP' },
          { value: 'discovery', label: 'Discovery' },
          { value: 'inventory', label: 'Inventory' },
          { value: 'integrations', label: 'Integrations' },
          { value: 'backup', label: 'Backup' },
        ]}
      />

      {tab === 'setup' && <SetupTab setMessage={setMessage} onChanged={() => void reload()} />}

      {tab === 'polling' && (
        <div className="grid gap-4 xl:grid-cols-2">
          <Panel title="Cadence" bodyClassName="grid gap-3 p-3 sm:grid-cols-2">
            <Num label="Infrastructure ping (s)" hint="Router, switches, APs, gateways and favourites." value={draft.polling.infraPingSeconds} min={5} onChange={(v) => update({ polling: { ...draft.polling, infraPingSeconds: v } })} />
            <Num label="Port status & counters (s)" hint="Per switch; link state and traffic rates." value={draft.polling.snmpFastSeconds} min={10} onChange={(v) => update({ polling: { ...draft.polling, snmpFastSeconds: v } })} />
            <Num label="MAC & LLDP tables (s)" hint="Where devices are plugged in." value={draft.polling.snmpTablesSeconds} min={30} onChange={(v) => update({ polling: { ...draft.polling, snmpTablesSeconds: v } })} />
            <Num label="VLAN configuration (s)" hint="Rarely changes; keeps the plan comparison fresh." value={draft.polling.snmpConfigSeconds} min={60} onChange={(v) => update({ polling: { ...draft.polling, snmpConfigSeconds: v } })} />
            <Num label="Router ARP table (s)" value={draft.polling.routerArpSeconds} min={15} onChange={(v) => update({ polling: { ...draft.polling, routerArpSeconds: v } })} />
            <Num label="WAN throughput (s)" hint="Router interface counters — a handful of GETs." value={draft.polling.routerTrafficSeconds} min={5} onChange={(v) => update({ polling: { ...draft.polling, routerTrafficSeconds: v } })} />
            <Num label="Local neighbour table (s)" value={draft.polling.neighborSeconds} min={5} onChange={(v) => update({ polling: { ...draft.polling, neighborSeconds: v } })} />
            <Num label="Subnet sweep (s)" hint="One /24 at a time, paced 10 ms per packet." value={draft.polling.sweepSeconds} min={60} onChange={(v) => update({ polling: { ...draft.polling, sweepSeconds: v } })} />
            <Num label="Reverse DNS (s)" value={draft.polling.dnsSeconds} min={60} onChange={(v) => update({ polling: { ...draft.polling, dnsSeconds: v } })} />
            <Num label="SNMP devices polled at once" value={draft.polling.snmpConcurrency} min={1} max={8} onChange={(v) => update({ polling: { ...draft.polling, snmpConcurrency: v } })} />
            <Num label="Minimum gap between runs (s)" hint="Applies to manual refresh too." value={draft.polling.minGapSeconds} min={1} onChange={(v) => update({ polling: { ...draft.polling, minGapSeconds: v } })} />
          </Panel>
          <Panel title="Thresholds" bodyClassName="grid gap-3 p-3 sm:grid-cols-2">
            <Num label="Stale after (s)" hint="No confirmation for this long → stale." value={draft.thresholds.staleAfterSeconds} min={30} onChange={(v) => update({ thresholds: { ...draft.thresholds, staleAfterSeconds: v } })} />
            <Num label="Offline after (s)" value={draft.thresholds.offlineAfterSeconds} min={60} onChange={(v) => update({ thresholds: { ...draft.thresholds, offlineAfterSeconds: v } })} />
            <Num label="Relocation window (s)" hint="How long a moved device shows as “relocating”." value={draft.thresholds.relocationWindowSeconds} min={30} onChange={(v) => update({ thresholds: { ...draft.thresholds, relocationWindowSeconds: v } })} />
            <Num label="Uplink MAC threshold" hint="More MACs than this on a port → treated as uplink." value={draft.thresholds.uplinkMacThreshold} min={2} onChange={(v) => update({ thresholds: { ...draft.thresholds, uplinkMacThreshold: v } })} />
            <Num label="Port errors per minute" hint="Above this a port is flagged." value={draft.thresholds.portErrorsPerMinute} min={0} onChange={(v) => update({ thresholds: { ...draft.thresholds, portErrorsPerMinute: v } })} />
            <Num label="Events kept" value={draft.thresholds.eventHistory} min={50} max={5000} onChange={(v) => update({ thresholds: { ...draft.thresholds, eventHistory: v } })} />
          </Panel>
          <Panel title="Scheduled jobs" bodyClassName="p-0" className="xl:col-span-2">
            <table className="w-full text-left text-[12px]">
              <thead className="bg-surface-2 text-2xs uppercase tracking-wider text-faint">
                <tr>
                  <th className="px-3 py-2 font-semibold">Job</th>
                  <th className="px-3 py-2 font-semibold">Every</th>
                  <th className="px-3 py-2 font-semibold">Last run</th>
                  <th className="hidden px-3 py-2 font-semibold sm:table-cell">Took</th>
                  <th className="px-3 py-2 font-semibold">Next</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {(scan ?? state.scan).jobs.map((job) => (
                  <tr key={job.id} className="hover:bg-surface-2">
                    <td className="px-3 py-1.5 text-ink">{job.label}</td>
                    <td className="tabular px-3 py-1.5 text-muted">{job.intervalSeconds ? `${job.intervalSeconds}s` : 'manual'}</td>
                    <td className="px-3 py-1.5 text-muted">{job.lastFinishedAt ? <Age iso={job.lastFinishedAt} /> : '—'}</td>
                    <td className="tabular hidden px-3 py-1.5 text-muted sm:table-cell">{job.lastDurationMs !== null ? `${job.lastDurationMs} ms` : '—'}</td>
                    <td className="px-3 py-1.5 text-muted">{job.running ? 'running' : job.queued ? 'queued' : job.nextDueAt ? <Age iso={job.nextDueAt} /> : '—'}</td>
                    <td className="px-3 py-1.5">
                      {job.running ? (
                        <Spinner size={12} className="text-accent" />
                      ) : job.lastError ? (
                        <Badge tone="danger" title={job.lastError}>
                          failed ×{job.failures}
                        </Badge>
                      ) : job.runs ? (
                        <Badge tone="ok">ok</Badge>
                      ) : (
                        <Badge>pending</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      )}

      {tab === 'snmp' && (
        <div className="grid gap-4 xl:grid-cols-2">
          <Panel title="Connection" bodyClassName="grid gap-3 p-3 sm:grid-cols-2">
            <Num label="Timeout (ms)" value={draft.snmp.timeoutMs} min={200} onChange={(v) => update({ snmp: { ...draft.snmp, timeoutMs: v } })} />
            <Num label="Retries" value={draft.snmp.retries} min={0} max={5} onChange={(v) => update({ snmp: { ...draft.snmp, retries: v } })} />
            <div className="sm:col-span-2">
              <p className="mb-2 text-2xs font-semibold uppercase tracking-wider text-faint">Default communities by manufacturer</p>
              <p className="mb-2 text-[12px] text-muted">Used for every planned device of that vendor unless it has its own entry on the right. Leave a field as it is to keep the stored secret.</p>
              <div className="space-y-2">
                {Object.entries(draft.snmp.defaultCommunities).map(([vendor, community]) => (
                  <div key={vendor} className="grid grid-cols-[120px_1fr] items-center gap-2">
                    <span className="text-[12px] capitalize text-ink">{vendor}</span>
                    <Input type="password" autoComplete="off" value={community} onChange={(event) => update({ snmp: { ...draft.snmp, defaultCommunities: { ...draft.snmp.defaultCommunities, [vendor]: event.target.value } } })} className="mono" />
                  </div>
                ))}
              </div>
            </div>
          </Panel>
          <Panel title="Per-device targets" bodyClassName="p-3">
            <p className="mb-3 text-[12px] leading-5 text-muted">Override the community for one device, disable SNMP for it, or use SNMP v1. Access points only get polled when listed here (standalone Omada EAPs have no SNMP).</p>
            <div className="space-y-2">
              {state.plannedDevices
                .filter((device) => device.managementIp && ['switch', 'router', 'access-point'].includes(device.type))
                .map((device) => {
                  const target = draft.snmp.targets.find((item) => item.deviceId === device.id)
                  const setTarget = (next: SnmpTarget | null) =>
                    update({ snmp: { ...draft.snmp, targets: [...draft.snmp.targets.filter((item) => item.deviceId !== device.id), ...(next ? [next] : [])] } })
                  return (
                    <div key={device.id} className="rounded border border-line p-2">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink">
                          {device.name} <span className="mono font-normal text-faint">{device.managementIp}</span>
                        </span>
                        {target ? (
                          <Button size="sm" variant="ghost" onClick={() => setTarget(null)}>
                            Use vendor default
                          </Button>
                        ) : (
                          <Button size="sm" onClick={() => setTarget({ deviceId: device.id, community: '', version: '2c', port: 161, enabled: true })}>
                            Override
                          </Button>
                        )}
                      </div>
                      {target && (
                        <div className="mt-2 grid grid-cols-[1fr_auto_auto_auto] items-end gap-2">
                          <Field label="Community">
                            <Input type="password" autoComplete="off" value={target.community} onChange={(event) => setTarget({ ...target, community: event.target.value })} className="mono" />
                          </Field>
                          <Field label="Version">
                            <Select value={target.version} onChange={(event) => setTarget({ ...target, version: event.target.value as '1' | '2c' })}>
                              <option value="2c">v2c</option>
                              <option value="1">v1</option>
                            </Select>
                          </Field>
                          <Field label="Port">
                            <Input type="number" value={target.port} onChange={(event) => setTarget({ ...target, port: Number(event.target.value) })} className="w-20" />
                          </Field>
                          <Toggle checked={target.enabled} onChange={(value) => setTarget({ ...target, enabled: value })} label="On" />
                        </div>
                      )}
                    </div>
                  )
                })}
            </div>
          </Panel>
        </div>
      )}

      {tab === 'discovery' && (
        <div className="grid gap-4 xl:grid-cols-2">
          <Panel title="Sources" bodyClassName="space-y-1 p-3">
            <Toggle checked={draft.discovery.sweepEnabled} onChange={(value) => update({ discovery: { ...draft.discovery, sweepEnabled: value } })} label="Ping sweeps" hint="Walks every planned subnet with fping. Finds devices that never talk to the Pi." />
            <Toggle checked={draft.discovery.routerArp} onChange={(value) => update({ discovery: { ...draft.discovery, routerArp: value } })} label="Router ARP table (SNMP)" hint="The best IP↔MAC source for VLANs the Pi is not directly in." />
            <Toggle checked={draft.discovery.localNeighbors} onChange={(value) => update({ discovery: { ...draft.discovery, localNeighbors: value } })} label="Pi neighbour table" hint="ip neigh — fresh and free, for on-link subnets." />
            <Toggle checked={draft.discovery.reverseDns} onChange={(value) => update({ discovery: { ...draft.discovery, reverseDns: value } })} label="Reverse DNS names" hint="Asks the router for hostnames of discovered IPs." />
            <Toggle checked={draft.ui.showMacOnly} onChange={(value) => update({ ui: { ...draft.ui, showMacOnly: value } })} label="Show MAC-only observations by default" hint="Usually off: they are correlation data, not devices." />
          </Panel>
          <Panel title="Internet & DNS check" bodyClassName="space-y-3 p-3">
            <Toggle checked={draft.internet.enabled} onChange={(value) => update({ internet: { ...draft.internet, enabled: value } })} label="Check WAN and DNS from the Pi" hint="Pings the targets below and resolves a hostname through the Pi's DNS." />
            <Field label="Ping targets (one per line)" hint="WAN counts as up when any answers.">
              <textarea
                rows={3}
                value={draft.internet.targets.join('\n')}
                onChange={(event) => update({ internet: { ...draft.internet, targets: event.target.value.split(/\s+/).filter(Boolean) } })}
                className="mono w-full rounded border border-line bg-surface px-2 py-1.5 text-[13px] text-ink"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="DNS check hostname">
                <Input value={draft.internet.dnsCheckHost} onChange={(event) => update({ internet: { ...draft.internet, dnsCheckHost: event.target.value } })} />
              </Field>
              <Num label="Interval (s)" value={draft.internet.intervalSeconds} min={10} onChange={(v) => update({ internet: { ...draft.internet, intervalSeconds: v } })} />
            </div>
            <Field label="WAN interfaces on the router" hint="Interface names whose counters are the internet throughput (comma separated). Empty = detect DSL-*, WAN-*, PPPoE, LTE names automatically.">
              <Input
                className="mono"
                value={draft.internet.wanInterfaces.join(', ')}
                placeholder="auto (e.g. DSL-1)"
                onChange={(event) => update({ internet: { ...draft.internet, wanInterfaces: event.target.value.split(/[,\s]+/).filter(Boolean) } })}
              />
            </Field>
          </Panel>
          <Panel title="Sweep ranges" bodyClassName="space-y-3 p-3">
            <Field label="Subnets to sweep (CIDR, one per line)" hint="Empty = every planned subnet. Ranges larger than /22 are refused.">
              <textarea
                rows={5}
                value={draft.discovery.sweepCidrs.join('\n')}
                onChange={(event) => update({ discovery: { ...draft.discovery, sweepCidrs: event.target.value.split(/\s+/).filter(Boolean) } })}
                className="mono w-full rounded border border-line bg-surface px-2 py-1.5 text-[13px] text-ink"
                placeholder={state.subnets.map((subnet) => subnet.cidr).join('\n')}
              />
            </Field>
            <Field label="Never sweep" hint="WAN or guest ranges you do not want touched.">
              <textarea
                rows={3}
                value={draft.discovery.excludeCidrs.join('\n')}
                onChange={(event) => update({ discovery: { ...draft.discovery, excludeCidrs: event.target.value.split(/\s+/).filter(Boolean) } })}
                className="mono w-full rounded border border-line bg-surface px-2 py-1.5 text-[13px] text-ink"
              />
            </Field>
            <div className="rounded bg-surface-2 p-2 text-[12px] leading-5 text-muted">
              <p className="font-semibold text-ink">This Pi</p>
              <p>
                Tools: {state.backend.capabilities.fping ? 'fping' : state.backend.capabilities.ping ? 'system ping (install fping for faster sweeps)' : 'no ping tool'} · {state.backend.capabilities.ipNeigh ? 'ip neigh' : state.backend.capabilities.arp ? 'arp' : 'no neighbour table'} ·{' '}
                {state.backend.capabilities.snmp ? 'SNMP' : 'no SNMP module'}
              </p>
              <p>
                Interfaces:{' '}
                {state.backend.interfaces.map((iface) => `${iface.name} ${iface.cidr}${iface.vlanId !== null ? ` (VLAN ${iface.vlanId})` : ''}`).join(', ') || 'none'}
              </p>
            </div>
          </Panel>
        </div>
      )}

      {tab === 'inventory' && <InventoryTab onChanged={() => void reload()} setMessage={setMessage} />}

      {tab === 'integrations' && (
        <div className="grid gap-4 xl:grid-cols-2">
          <Panel title="Access points (standalone Omada EAPs)" bodyClassName="space-y-3 p-3">
            <p className="text-[12px] leading-5 text-muted">
              Standalone TP-Link EAPs are read through their own web UI (the same login you use in the browser). This fills the WLAN page and gives Wi-Fi devices their AP, SSID and signal. Every planned access point in the setup is polled with these credentials. The password is stored on the Pi only and never
              shown again. Note: an EAP allows one admin session — opening its web UI logs the monitor out until the next poll, and vice versa.
            </p>
            <Toggle checked={draft.accessPoints.enabled} onChange={(value) => update({ accessPoints: { ...draft.accessPoints, enabled: value } })} label="Enabled" />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Username">
                <Input value={draft.accessPoints.username} autoComplete="off" onChange={(event) => update({ accessPoints: { ...draft.accessPoints, username: event.target.value } })} />
              </Field>
              <Field label="Password">
                <Input type="password" autoComplete="new-password" value={draft.accessPoints.password} onChange={(event) => update({ accessPoints: { ...draft.accessPoints, password: event.target.value } })} />
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Num label="Clients every (s)" hint="Client and SSID lists — two small requests per AP." value={draft.accessPoints.intervalSeconds} min={5} onChange={(v) => update({ accessPoints: { ...draft.accessPoints, intervalSeconds: v } })} />
              <Num label="Details every N polls" hint="Radio settings, counters, uptime." value={draft.accessPoints.detailEvery} min={1} max={100} onChange={(v) => update({ accessPoints: { ...draft.accessPoints, detailEvery: v } })} />
              <Num label="Timeout (ms)" value={draft.accessPoints.timeoutMs} min={500} max={30000} onChange={(v) => update({ accessPoints: { ...draft.accessPoints, timeoutMs: v } })} />
            </div>
          </Panel>
          <Panel title="TP-Link Omada controller" bodyClassName="space-y-3 p-3">
            <p className="text-[12px] leading-5 text-muted">Optional, for sites that run an Omada controller: with an Open API client (Settings → Platform Integration in Omada) the controller supplies the same AP and Wi-Fi client data for adopted APs.</p>
            <Toggle checked={draft.omada.enabled} onChange={(value) => update({ omada: { ...draft.omada, enabled: value } })} label="Enabled" />
            <Field label="Controller URL">
              <Input value={draft.omada.baseUrl} onChange={(event) => update({ omada: { ...draft.omada, baseUrl: event.target.value } })} placeholder="https://192.168.99.5:8043" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Omada ID">
                <Input value={draft.omada.omadacId} onChange={(event) => update({ omada: { ...draft.omada, omadacId: event.target.value } })} />
              </Field>
              <Field label="Site ID">
                <Input value={draft.omada.siteId} onChange={(event) => update({ omada: { ...draft.omada, siteId: event.target.value } })} />
              </Field>
              <Field label="Client ID">
                <Input value={draft.omada.clientId} onChange={(event) => update({ omada: { ...draft.omada, clientId: event.target.value } })} />
              </Field>
              <Field label="Client secret">
                <Input type="password" autoComplete="off" value={draft.omada.clientSecret} onChange={(event) => update({ omada: { ...draft.omada, clientSecret: event.target.value } })} />
              </Field>
            </div>
            <Toggle checked={draft.omada.insecureTls} onChange={(value) => update({ omada: { ...draft.omada, insecureTls: value } })} label="Accept self-signed certificate" />
            <Num label="Interval (s)" value={draft.omada.intervalSeconds} min={15} onChange={(v) => update({ omada: { ...draft.omada, intervalSeconds: v } })} />
          </Panel>
          <Panel title="Syslog receiver" bodyClassName="space-y-3 p-3">
            <p className="text-[12px] leading-5 text-muted">Point the switches and router at the Pi as a syslog server and their link changes, logins and STP events appear in the Events timeline. Ports below 1024 need extra permissions; 5514 works without.</p>
            <Toggle checked={draft.syslog.enabled} onChange={(value) => update({ syslog: { ...draft.syslog, enabled: value } })} label="Enabled" />
            <Num label="UDP port" value={draft.syslog.port} min={1} max={65535} onChange={(v) => update({ syslog: { ...draft.syslog, port: v } })} />
          </Panel>
        </div>
      )}

      {tab === 'backup' && <BackupTab setMessage={setMessage} onChanged={() => void reload()} />}
    </Page>
  )
}

function SetupTab({ setMessage, onChanged }: { setMessage: (message: { tone: 'ok' | 'danger'; text: string }) => void; onChanged: () => void }) {
  const state = useMonitor((store) => store.state)!
  const [busy, setBusy] = useState<string | null>(null)
  const toggle = async (id: string, inUse: boolean) => {
    setBusy(id)
    try {
      await api.setInUse(id, inUse)
      onChanged()
    } catch (error) {
      setMessage({ tone: 'danger', text: error instanceof Error ? error.message : 'Failed' })
    } finally {
      setBusy(null)
    }
  }
  const reset = async () => {
    if (!confirm('Start a new setup? Devices added automatically and learned trunk links are forgotten. Manual choices and device names stay.')) return
    setBusy('reset')
    try {
      await api.resetSetup()
      setMessage({ tone: 'ok', text: 'New setup started.' })
      onChanged()
    } finally {
      setBusy(null)
    }
  }
  const sorted = [...state.infra].sort((a, b) => Number(b.inUse) - Number(a.inUse) || a.name.localeCompare(b.name))
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
      <Panel title="Devices in this setup" bodyClassName="p-0">
        <p className="px-3 py-2 text-[12px] leading-5 text-muted">
          Not every planned device is on every job. Only devices <strong className="text-ink">in use</strong> are polled over SNMP and can raise problems. A device joins automatically the first time it answers a ping and is never removed automatically — switch it off here when it is intentionally not connected.
        </p>
        <div className="divide-y divide-line">
          {sorted.map((item) => (
            <div key={item.id} className={cn('flex items-center gap-3 px-3 py-2', !item.inUse && 'opacity-70')}>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                  {item.name}
                  <span className="mono text-[11px] font-normal text-faint">{item.managementIp}</span>
                </span>
                <span className="block text-[11px] text-faint">
                  {item.type.replace('-', ' ')} · {item.model || 'no model'}
                  {item.inUse && item.inUseSource && (
                    <>
                      {' '}
                      · {item.inUseSource === 'auto' ? 'added automatically' : 'added manually'} <Age iso={item.inUseSince} />
                    </>
                  )}
                </span>
              </span>
              {item.monitored ? <ReachBadge value={item.reachability} /> : <Badge>not monitored</Badge>}
              <span className="w-[120px] shrink-0">
                <Toggle checked={item.inUse} onChange={(value) => void toggle(item.id, value)} label={busy === item.id ? '…' : item.inUse ? 'In use' : 'Not used'} />
              </span>
            </div>
          ))}
        </div>
      </Panel>
      <Panel title="New show" bodyClassName="space-y-3 p-3">
        <p className="text-[12px] leading-5 text-muted">
          Before the next job, start a new setup: devices that joined automatically and trunk links that were seen up are forgotten, so a switch that stays in the case does not show as an outage. Names, notes and manual choices are kept.
        </p>
        <Button variant="danger" onClick={() => void reset()} disabled={busy === 'reset'}>
          {busy === 'reset' ? <Spinner size={12} /> : <RotateCcw size={13} />}
          Start new setup
        </Button>
      </Panel>
    </div>
  )
}

function Num({ label, hint, value, min, max, onChange }: { label: string; hint?: string; value: number; min?: number; max?: number; onChange: (value: number) => void }) {
  return (
    <Field label={label} hint={hint}>
      <Input type="number" value={value} min={min} max={max} onChange={(event) => onChange(Number(event.target.value))} className="tabular" />
    </Field>
  )
}

function InventoryTab({ onChanged, setMessage }: { onChanged: () => void; setMessage: (message: { tone: 'ok' | 'danger'; text: string }) => void }) {
  const state = useMonitor((store) => store.state)!
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const upload = async (file: File) => {
    setBusy(true)
    try {
      const json = JSON.parse(await file.text()) as unknown
      const result = await api.uploadInventory(json)
      setMessage({ tone: 'ok', text: `Inventory replaced: ${result.projectName}, ${result.devices} devices.` })
      onChanged()
    } catch (error) {
      setMessage({ tone: 'danger', text: error instanceof Error ? error.message : 'Upload failed' })
    } finally {
      setBusy(false)
    }
  }
  const sync = async () => {
    setSyncing(true)
    try {
      const result = await api.syncInventory()
      const revision = result.revision !== null ? ` revision ${result.revision},` : ''
      setMessage({ tone: 'ok', text: `Inventory resynced:${revision} ${result.projectName}, ${result.devices} devices.` })
      onChanged()
    } catch (error) {
      setMessage({ tone: 'danger', text: error instanceof Error ? error.message : 'Sync failed' })
    } finally {
      setSyncing(false)
    }
  }
  return (
    <div className="space-y-4">
      <Panel
        title="Planned inventory"
        actions={
          <>
            <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => event.target.files?.[0] && void upload(event.target.files[0])} />
            <Button size="sm" onClick={() => void sync()} disabled={busy || syncing}>
              {syncing ? <Spinner size={12} /> : <RefreshCw size={12} />}
              Resync network config
            </Button>
            <Button size="sm" onClick={() => fileRef.current?.click()} disabled={busy || syncing}>
              {busy ? <Spinner size={12} /> : <Upload size={12} />}
              Upload planner JSON
            </Button>
          </>
        }
        bodyClassName="p-0"
      >
        <p className="px-3 py-2 text-[12px] leading-5 text-muted">
          The plan is the export of the Network Config planner. Upload a new export whenever it changes. Management IPs can be corrected right here — click one to edit; the change is kept on the Pi until the next upload, so fix it in the planner too.
        </p>
        <table className="w-full text-left text-[12px]">
          <thead className="bg-surface-2 text-2xs uppercase tracking-wider text-faint">
            <tr>
              <th className="px-3 py-2 font-semibold">Device</th>
              <th className="px-3 py-2 font-semibold">Type</th>
              <th className="hidden px-3 py-2 font-semibold sm:table-cell">Model</th>
              <th className="px-3 py-2 font-semibold">Management IP</th>
              <th className="hidden px-3 py-2 font-semibold md:table-cell">Location</th>
              <th className="hidden px-3 py-2 font-semibold lg:table-cell">Ports</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {state.plannedDevices.map((device) => (
              <tr key={device.id}>
                <td className="px-3 py-1.5 font-semibold text-ink">{device.name}</td>
                <td className="px-3 py-1.5 text-muted">{device.type}</td>
                <td className="hidden px-3 py-1.5 text-muted sm:table-cell">
                  {device.manufacturer} {device.model}
                </td>
                <td className="px-3 py-1.5">
                  <IpEditor id={device.id} value={device.managementIp} onSaved={onChanged} setMessage={setMessage} />
                </td>
                <td className="hidden px-3 py-1.5 text-muted md:table-cell">{[device.location, device.rack].filter((part, index, all) => part && all.indexOf(part) === index).join(' · ')}</td>
                <td className="hidden px-3 py-1.5 text-muted lg:table-cell">
                  {device.portCount}
                  {device.sfpPortCount ? ` + ${device.sfpPortCount} SFP` : ''}
                  {device.wanPortCount ? ` + ${device.wanPortCount} WAN` : ''} · {device.layout}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel title="Planned VLANs & subnets" bodyClassName="p-0">
        <table className="w-full text-left text-[12px]">
          <thead className="bg-surface-2 text-2xs uppercase tracking-wider text-faint">
            <tr>
              <th className="px-3 py-2 font-semibold">VLAN</th>
              <th className="px-3 py-2 font-semibold">Subnet</th>
              <th className="px-3 py-2 font-semibold">Gateway</th>
              <th className="hidden px-3 py-2 font-semibold sm:table-cell">DHCP</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {state.vlans
              .filter((vlan) => vlan.planned)
              .map((vlan) => (
                <tr key={vlan.vlanId}>
                  <td className="px-3 py-1.5">
                    <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: vlan.color }} />
                    <span className="tabular font-semibold text-ink">{vlan.vlanId}</span> <span className="text-ink">{vlan.name}</span>
                  </td>
                  <td className="mono px-3 py-1.5 text-muted">{vlan.subnet?.cidr ?? '—'}</td>
                  <td className="mono px-3 py-1.5 text-muted">{vlan.subnet?.gateway ?? '—'}</td>
                  <td className="mono hidden px-3 py-1.5 text-muted sm:table-cell">{vlan.subnet?.dhcpStart ? `${vlan.subnet.dhcpStart} – ${vlan.subnet.dhcpEnd}` : '—'}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </Panel>
    </div>
  )
}

/** Click-to-edit management IP; saves on Enter or blur, Escape cancels. */
function IpEditor({ id, value, onSaved, setMessage }: { id: string; value: string; onSaved: () => void; setMessage: (message: { tone: 'ok' | 'danger'; text: string }) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (draft.trim() === value) return setEditing(false)
    setBusy(true)
    try {
      await api.setManagementIp(id, draft.trim())
      setMessage({ tone: 'ok', text: `Management IP set to ${draft.trim() || 'none'}.` })
      onSaved()
      setEditing(false)
    } catch (error) {
      setMessage({ tone: 'danger', text: error instanceof Error ? error.message : 'Save failed' })
    } finally {
      setBusy(false)
    }
  }
  if (!editing)
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(value)
          setEditing(true)
        }}
        title="Click to change"
        className="mono rounded px-1 py-0.5 text-left text-muted hover:bg-surface-2 hover:text-ink"
      >
        {value || <span className="text-faint">none</span>}
      </button>
    )
  return (
    <Input
      autoFocus
      value={draft}
      disabled={busy}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void save()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') void save()
        if (event.key === 'Escape') setEditing(false)
      }}
      className="mono !h-7 w-36"
      placeholder="192.168.99.10"
    />
  )
}

function BackupTab({ setMessage, onChanged }: { setMessage: (message: { tone: 'ok' | 'danger'; text: string }) => void; onChanged: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const importFile = async (file: File) => {
    setBusy(true)
    try {
      const json = JSON.parse(await file.text()) as unknown
      const result = await api.importBackup(json)
      setMessage({ tone: 'ok', text: `Imported ${result.knownDevices} known devices${result.settings ? ' and settings' : ''}.` })
      onChanged()
    } catch (error) {
      setMessage({ tone: 'danger', text: error instanceof Error ? error.message : 'Import failed' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Panel title="Export" bodyClassName="space-y-3 p-3">
        <p className="text-[12px] leading-5 text-muted">Downloads settings (including SNMP communities) and all known-device metadata as one JSON file. Keep it with the show documentation so a fresh Pi can be restored in a minute.</p>
        <a href={api.exportUrl} download>
          <Button>
            <Download size={13} /> Download backup
          </Button>
        </a>
      </Panel>
      <Panel title="Import" bodyClassName="space-y-3 p-3">
        <p className="text-[12px] leading-5 text-muted">Restores a backup. Known devices are merged by id; settings are merged over the current ones.</p>
        <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => event.target.files?.[0] && void importFile(event.target.files[0])} />
        <Button onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? <Spinner size={12} /> : <Upload size={13} />}
          Import backup file
        </Button>
      </Panel>
    </div>
  )
}
