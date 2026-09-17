import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ChevronLeft, EyeOff, Save, Star, Trash2 } from 'lucide-react'
import type { DeviceState, KnownDeviceMeta } from '@shared/types'
import { Page } from '@/app/Page'
import { LoadingState } from '@/components/Loading'
import { ProblemCard } from '@/components/ProblemCard'
import { EventRow } from '@/components/EventRow'
import { Age, DeviceStatusBadge, VlanChip, deviceStatusHint } from '@/components/status'
import { api } from '@/api/client'
import { useMonitor } from '@/stores/monitorStore'
import { Badge, Button, EmptyState, Field, Input, KeyValue, Panel, Textarea, Toggle } from '@/ui/kit'
import { formatDateTime } from '@/utils/format'

const CATEGORIES = ['Console', 'Computer', 'Audio', 'Lighting', 'Video', 'Network', 'Phone/Tablet', 'Printer', 'Other']

export function DevicePage() {
  const { id = '' } = useParams()
  const state = useMonitor((store) => store.state)
  const reload = useMonitor((store) => store.reload)
  const navigate = useNavigate()
  const device = state?.devices.find((item) => item.id === decodeURIComponent(id))
  if (!state) return <LoadingState />
  if (!device)
    return (
      <Page title="Device not found" description="It may have been merged into another device (MAC alias) or dropped from the list after being offline for long.">
        <Link to="/devices">
          <Button>
            <ChevronLeft size={14} /> Back to devices
          </Button>
        </Link>
      </Page>
    )
  const problems = state.problems.filter((problem) => problem.subject.type === 'device' && problem.subject.id === device.id)
  const events = state.events.filter((event) => event.subject?.type === 'device' && event.subject.id === device.id).slice(0, 20)
  const infra = device.infraId ? state.infra.find((item) => item.id === device.infraId) : null

  return (
    <Page
      title={
        <span className="flex items-center gap-2">
          <Link to="/devices" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-ink" aria-label="Back to devices">
            <ChevronLeft size={18} />
          </Link>
          {device.known?.favorite && <Star size={16} className="fill-warn text-warn" />}
          {device.known?.ignored && <EyeOff size={16} className="text-faint" />}
          <span className="truncate">{device.name}</span>
          <DeviceStatusBadge status={device.status} />
        </span>
      }
      description={deviceStatusHint[device.status]}
      actions={
        infra ? (
          <Link to={infra.type === 'switch' ? `/switches/${infra.id}` : '/overview'}>
            <Button>Infrastructure: {infra.name}</Button>
          </Link>
        ) : null
      }
    >
      <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <div className="min-w-0 space-y-4">
          <Panel title="Identity & location" bodyClassName="p-3">
            <KeyValue
              items={[
                { label: 'IP', value: device.ips.length ? device.ips.join(', ') : <span className="text-faint">none seen (MAC-only observation)</span>, mono: true },
                { label: 'MAC', value: device.macs.length ? device.macs.join(', ') : <span className="text-faint">unknown — only an IP answered</span>, mono: true },
                { label: 'Vendor', value: device.vendor ?? '—' },
                { label: 'Hostname', value: device.hostname ?? '—', mono: true },
                {
                  label: 'VLAN',
                  value: (
                    <span className="flex items-center gap-2">
                      <VlanChip vlanId={device.vlanId} vlans={state.vlans} />
                      {device.vlanSource && <span className="text-faint">from {device.vlanSource === 'subnet' ? 'IP subnet' : 'switch MAC table'}</span>}
                    </span>
                  ),
                },
                {
                  label: 'Plugged into',
                  value: device.location ? (
                    <span>
                      <Link to={`/switches/${device.location.switchId}?port=${device.location.port}`} className="font-semibold text-accent-text hover:underline">
                        {device.location.switchName} · port {device.location.port}
                      </Link>
                      {device.location.portName && <span className="text-muted"> ({device.location.portName})</span>}
                      <span className="block text-faint">
                        since {formatDateTime(device.location.since)} · confirmed <Age iso={device.location.lastSeenAt} />
                      </span>
                    </span>
                  ) : device.wireless ? (
                    <span>
                      Wi-Fi via {device.wireless.ap ?? 'unknown AP'} {device.wireless.ssid && `· ${device.wireless.ssid}`} {device.wireless.band && `· ${device.wireless.band}`}
                    </span>
                  ) : (
                    <span className="text-warn">No switch port attributed{device.flags.find((flag) => flag.startsWith('seen via')) ? ` — ${device.flags.find((flag) => flag.startsWith('seen via'))}` : ''}</span>
                  ),
                },
                ...(device.previousLocation
                  ? [
                      {
                        label: 'Previously',
                        value: (
                          <span>
                            {device.previousLocation.switchName} · port {device.previousLocation.port} <span className="text-faint">until {formatDateTime(device.previousLocation.lastSeenAt)}</span>
                          </span>
                        ),
                      },
                    ]
                  : []),
                { label: 'First seen', value: formatDateTime(device.firstSeenAt) },
                { label: 'Last seen', value: <Age iso={device.lastSeenAt} /> },
                { label: 'Confirmed alive', value: device.lastConfirmedAt ? <Age iso={device.lastConfirmedAt} /> : <span className="text-faint">never (only in ARP tables)</span> },
                { label: 'Latency', value: device.rttMs !== null ? `${device.rttMs.toFixed(1)} ms` : '—' },
                { label: 'Sources', value: device.sources.map((source) => <Badge key={source} className="mr-1">{sourceLabel[source]}</Badge>) },
              ]}
            />
            {device.flags.length > 0 && (
              <ul className="mt-3 space-y-1 rounded bg-warn-soft p-2 text-[12px] leading-5 text-warn">
                {device.flags.map((flag) => (
                  <li key={flag}>• {flag}</li>
                ))}
              </ul>
            )}
          </Panel>

          {problems.length > 0 && (
            <Panel title="Problems involving this device" bodyClassName="space-y-2 p-2">
              {problems.map((problem) => (
                <ProblemCard key={problem.id} problem={problem} expanded />
              ))}
            </Panel>
          )}

          <Panel title="History" bodyClassName="p-1.5">
            {events.length === 0 ? <p className="px-2 py-4 text-center text-[12px] text-muted">No recorded events for this device yet.</p> : events.map((event) => <EventRow key={event.id} event={event} showDate />)}
          </Panel>
        </div>

        <MetaEditor key={device.id + (device.known?.updatedAt ?? '')} device={device} onSaved={() => void reload()} onDeleted={() => navigate('/devices')} />
      </div>
    </Page>
  )
}

const sourceLabel: Record<DeviceState['sources'][number], string> = {
  ping: 'ping',
  arp: 'router ARP',
  neighbor: 'Pi neighbour table',
  fdb: 'switch MAC table',
  lldp: 'LLDP',
  dns: 'reverse DNS',
  omada: 'Omada',
  inventory: 'inventory',
}

function MetaEditor({ device, onSaved, onDeleted }: { device: DeviceState; onSaved: () => void; onDeleted: () => void }) {
  const known = device.known
  const [draft, setDraft] = useState<Partial<KnownDeviceMeta>>({
    displayName: known?.displayName ?? '',
    owner: known?.owner ?? '',
    category: known?.category ?? '',
    notes: known?.notes ?? '',
    favorite: known?.favorite ?? false,
    ignored: known?.ignored ?? false,
    macs: known?.macs ?? device.macs,
    ips: known?.ips ?? [],
  })
  const [macText, setMacText] = useState((known?.macs ?? device.macs).join('\n'))
  const [ipText, setIpText] = useState((known?.ips ?? []).join('\n'))
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)
  useEffect(() => {
    if (!message) return
    const timer = setTimeout(() => setMessage(null), 4000)
    return () => clearTimeout(timer)
  }, [message])

  const save = async (patch: Partial<KnownDeviceMeta> = {}) => {
    setSaving(true)
    try {
      const body = {
        ...draft,
        ...patch,
        macs: macText.split(/[\s,;]+/).filter(Boolean),
        ips: ipText.split(/[\s,;]+/).filter(Boolean),
      }
      await api.saveMeta(device.id, body)
      setMessage({ tone: 'ok', text: 'Saved' })
      onSaved()
    } catch (error) {
      setMessage({ tone: 'danger', text: error instanceof Error ? error.message : 'Save failed' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Panel
      title="Metadata"
      actions={
        <>
          <Button size="sm" variant={draft.favorite ? 'primary' : 'default'} onClick={() => void save({ favorite: !draft.favorite })} title="Favourites are pinged more often and raise a warning when they go offline.">
            <Star size={12} className={draft.favorite ? 'fill-current' : ''} />
            {draft.favorite ? 'Favourite' : 'Favourite'}
          </Button>
          <Button size="sm" onClick={() => void save({ ignored: !draft.ignored })} title="Ignored devices are hidden from lists and never raise problems.">
            <EyeOff size={12} />
            {draft.ignored ? 'Un-ignore' : 'Ignore'}
          </Button>
        </>
      }
      bodyClassName="p-3"
    >
      <p className="mb-3 text-[12px] leading-5 text-muted">
        Everything here follows the MAC address — rename it once and it stays named after DHCP hands out a new IP or someone re-patches it.
      </p>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <Field label="Display name">
          <Input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} placeholder={device.hostname ?? device.vendor ?? 'e.g. grandMA3 FOH'} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Owner">
            <Input value={draft.owner} onChange={(event) => setDraft({ ...draft, owner: event.target.value })} placeholder="Manu, Jakob…" />
          </Field>
          <Field label="Category">
            <Input list="device-categories" value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} placeholder="Lighting, Audio…" />
            <datalist id="device-categories">
              {CATEGORIES.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </Field>
        </div>
        <Field label="Notes">
          <Textarea value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} placeholder="Rack position, static IP reason, who to call…" />
        </Field>
        <Field label="MAC aliases" hint="One per line. A laptop with a dock and Wi-Fi is one device with two MACs.">
          <Textarea value={macText} onChange={(event) => setMacText(event.target.value)} className="mono" rows={3} />
        </Field>
        <Field label="Fixed IPs" hint="Only for devices whose MAC is never learned (behind a router). Optional.">
          <Textarea value={ipText} onChange={(event) => setIpText(event.target.value)} className="mono" rows={2} placeholder="192.168.10.50" />
        </Field>
        <Toggle checked={Boolean(draft.favorite)} onChange={(value) => setDraft({ ...draft, favorite: value })} label="Favourite" hint="Pinged every few seconds; offline raises a warning." />
        <Toggle checked={Boolean(draft.ignored)} onChange={(value) => setDraft({ ...draft, ignored: value })} label="Ignore" hint="Hidden from lists, never raises problems." />
        <div className="flex items-center gap-2 border-t border-line pt-3">
          <Button type="submit" variant="primary" disabled={saving}>
            <Save size={13} /> Save
          </Button>
          {known && (
            <Button
              variant="danger"
              disabled={saving}
              onClick={async () => {
                if (!confirm('Remove all metadata for this device?')) return
                await api.deleteMeta(device.id)
                onSaved()
                onDeleted()
              }}
            >
              <Trash2 size={13} /> Remove metadata
            </Button>
          )}
          {message && <span className={message.tone === 'ok' ? 'text-[12px] text-ok' : 'text-[12px] text-danger'}>{message.text}</span>}
          {known && !message && (
            <span className="ml-auto text-[11px] text-faint">
              edited <Age iso={known.updatedAt} />
            </span>
          )}
        </div>
      </form>
      {device.macOnly && !known && <div className="mt-3"><EmptyState title="MAC-only observation" description="This MAC was learned by a switch but never had an IP. Name it if you know what it is; otherwise it stays hidden from the device list." /></div>}
    </Panel>
  )
}
