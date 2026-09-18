import { Link } from 'react-router-dom'
import { AlertTriangle, RefreshCw, Wifi, WifiOff } from 'lucide-react'
import type { SignalQuality, VlanState, WlanAccessPoint, WlanClient } from '@shared/types'
import { Page } from '@/app/Page'
import { LoadingState } from '@/components/Loading'
import { Age, ReachDot, VlanChip } from '@/components/status'
import { useMonitor } from '@/stores/monitorStore'
import { cn } from '@/ui/cn'
import { Button, EmptyState, KeyValue, Panel, Spinner } from '@/ui/kit'
import { formatBps, formatDuration } from '@/utils/format'

const qualityTone: Record<SignalQuality, { bar: string; text: string; label: string }> = {
  excellent: { bar: 'bg-ok', text: 'text-ok', label: 'excellent' },
  good: { bar: 'bg-ok', text: 'text-ok', label: 'good' },
  fair: { bar: 'bg-warn', text: 'text-warn', label: 'fair' },
  poor: { bar: 'bg-danger', text: 'text-danger', label: 'poor' },
}

/** Four-bar signal indicator with the dBm value (RSSI as the AP hears the client). */
export function Signal({ dbm, quality, compact }: { dbm: number | null; quality: SignalQuality | null; compact?: boolean }) {
  if (dbm === null || !quality) return <span className="text-faint">—</span>
  const bars = quality === 'excellent' ? 4 : quality === 'good' ? 3 : quality === 'fair' ? 2 : 1
  const tone = qualityTone[quality]
  return (
    <span className="inline-flex items-center gap-1.5" title={`${dbm} dBm · ${tone.label}`}>
      <span className="flex items-end gap-px" aria-hidden>
        {[1, 2, 3, 4].map((level) => (
          <span key={level} className={cn('w-1 rounded-sm', level <= bars ? tone.bar : 'bg-line-strong')} style={{ height: 3 + level * 2.5 }} />
        ))}
      </span>
      <span className={cn('tabular text-[12px]', tone.text)}>{dbm} dBm</span>
      {!compact && <span className="text-[11px] text-faint">{tone.label}</span>}
    </span>
  )
}

export function WlanPage() {
  const state = useMonitor((store) => store.state)
  const requestScan = useMonitor((store) => store.requestScan)
  const requesting = useMonitor((store) => store.requesting)
  if (!state) return <LoadingState />
  const wlan = state.wlan
  // Only APs that are part of this setup matter during a show.
  const aps = wlan.accessPoints.filter((ap) => ap.inUse)
  const hidden = wlan.accessPoints.length - aps.length
  const failing = aps.filter((ap) => ap.poll && !ap.poll.ok && ap.reachability !== 'offline')
  const clients = aps.reduce((sum, ap) => sum + ap.clients.length, 0)

  return (
    <Page
      title="WLAN"
      description={
        wlan.configured && aps.length ? `${clients} Wi-Fi client${clients === 1 ? '' : 's'} on ${aps.length} access point${aps.length === 1 ? '' : 's'}.` : 'Which device is on which access point.'
      }
      actions={
        <Button variant="default" size="sm" onClick={() => void requestScan('wlan')} disabled={requesting || !wlan.configured}>
          {requesting ? <Spinner size={12} /> : <RefreshCw size={13} />} Refresh
        </Button>
      }
    >
      {!wlan.configured && (
        <Panel className="mb-4">
          <EmptyState
            icon={<WifiOff size={24} />}
            title="No AP login configured"
            description="Enter the access points' admin login under Settings → Integrations → Access points. Until then Wi-Fi devices only show up through the switches' MAC tables."
            action={
              <Link to="/settings#integrations">
                <Button variant="primary" size="sm">
                  Open settings
                </Button>
              </Link>
            }
          />
        </Panel>
      )}

      {failing.length > 0 && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-warn/50 bg-warn/10 px-3 py-2 text-[12px] leading-5 text-ink">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" />
          <div>
            {failing.map((ap) => (
              <p key={ap.id}>
                <span className="font-semibold">{ap.name}</span>: {ap.poll?.error}
              </p>
            ))}
          </div>
        </div>
      )}

      {wlan.configured && aps.length === 0 && (
        <Panel>
          <EmptyState icon={<Wifi size={24} />} title="No access point in this setup" description="A planned AP joins the setup when it answers a ping, or under Settings → Setup." />
        </Panel>
      )}

      <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {aps.map((ap) => (
          <AccessPointCard key={ap.id} ap={ap} vlans={state.vlans} />
        ))}
      </div>
      {hidden > 0 && (
        <p className="mt-3 text-[11px] text-faint">
          {hidden} access point{hidden === 1 ? '' : 's'} not in this setup hidden.
        </p>
      )}
    </Page>
  )
}

function AccessPointCard({ ap, vlans }: { ap: WlanAccessPoint; vlans: VlanState[] }) {
  const offline = ap.reachability === 'offline'
  const pollFailed = ap.poll !== null && !ap.poll.ok && !offline
  const channels = ap.radios.filter((radio) => radio.enabled && radio.channel !== null).map((radio) => `ch ${radio.channel}`)
  return (
    <div className={cn('flex flex-col rounded-lg border bg-surface', offline ? 'border-danger/50' : pollFailed ? 'border-warn/50' : 'border-line')}>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <ReachDot value={ap.reachability} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold text-ink">{ap.name}</p>
          <p className="truncate text-[11px] text-faint">
            {offline ? 'unreachable' : pollFailed ? 'no data — see above' : ap.poll?.lastOkAt ? channels.join(' · ') || ap.model || '' : 'waiting for first poll'}
            {!offline && ap.locatedAt && (
              <>
                {' · '}
                <Link to={`/switches/${ap.locatedAt.switchId}?port=${ap.locatedAt.port}`} className="hover:text-accent-text hover:underline">
                  {ap.locatedAt.switchName} {ap.locatedAt.port}
                </Link>
              </>
            )}
            {!offline && !ap.locatedAt && ap.attachedTo && ` · ${ap.attachedTo}`}
          </p>
        </div>
        <span className="tabular shrink-0 text-[18px] font-semibold text-ink" title="clients">
          {ap.clients.length}
        </span>
      </div>

      <div className="flex-1 border-t border-line">
        {ap.clients.length === 0 ? (
          <p className="px-3 py-3 text-[12px] text-muted">{offline ? 'Access point is down.' : pollFailed ? 'Cannot read this AP.' : 'No client connected.'}</p>
        ) : (
          <ul className="divide-y divide-line">
            {ap.clients.map((client) => (
              <ClientRow key={client.mac} client={client} vlans={vlans} />
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-line bg-surface-2 px-3 py-2 text-[12px]">
        <KeyValue
          items={[
            {
              label: 'Model',
              value: [ap.model, ap.hardware ? `v${ap.hardware}` : null].filter(Boolean).join(' ') || '—',
            },
            {
              label: 'Address',
              value: [ap.ip, ap.mac].filter(Boolean).join(' · ') || '—',
              mono: true,
            },
            { label: 'Firmware', value: ap.firmware ?? '—' },
            {
              label: 'Uptime',
              value: ap.uptimeSeconds !== null ? formatDuration(ap.uptimeSeconds) : '—',
            },
            {
              label: 'Load',
              value: ap.cpuPercent !== null || ap.memoryPercent !== null ? `CPU ${ap.cpuPercent ?? '—'} % · RAM ${ap.memoryPercent ?? '—'} %` : '—',
            },
            { label: 'LAN', value: ap.lanLink ?? '—' },
            ...ap.radios.map((radio) => ({
              label: radio.band,
              value: !radio.enabled
                ? 'disabled'
                : [
                    radio.channel !== null ? `ch ${radio.channel}` : null,
                    radio.widthMhz !== null ? `${radio.widthMhz} MHz` : null,
                    radio.txPowerDbm !== null ? `${radio.txPowerDbm} dBm` : null,
                    radio.txBps !== null ? `↓ ${formatBps(radio.txBps * 8)} ↑ ${formatBps((radio.rxBps ?? 0) * 8)}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · '),
            })),
            {
              label: 'SSIDs',
              value: (
                <span className="flex flex-wrap gap-1">
                  {[...new Set(ap.ssids.map((ssid) => ssid.ssid))].map((name) => {
                    const vlanId = ap.ssids.find((ssid) => ssid.ssid === name && ssid.vlanId !== null)?.vlanId ?? null
                    return (
                      <span key={name} className="inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 text-[11px]">
                        {name} {vlanId !== null && <VlanChip vlanId={vlanId} vlans={vlans} size="xs" showName={false} />}
                      </span>
                    )
                  })}
                  {ap.ssids.length === 0 && '—'}
                </span>
              ),
            },
            {
              label: 'Last read',
              value: ap.poll?.lastOkAt ? <Age iso={ap.poll.lastOkAt} /> : '—',
            },
          ]}
        />
      </div>
    </div>
  )
}

function ClientRow({ client, vlans }: { client: WlanClient; vlans: VlanState[] }) {
  const meta = [client.ip, client.ssid, client.band, client.connectedSeconds !== null ? formatDuration(client.connectedSeconds) : null].filter(Boolean).join(' · ')
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        {client.deviceId ? (
          <Link to={`/devices/${encodeURIComponent(client.deviceId)}`} className="block truncate text-[13px] font-medium text-ink hover:text-accent-text hover:underline">
            {client.name}
          </Link>
        ) : (
          <span className="block truncate text-[13px] font-medium text-ink">{client.name}</span>
        )}
        <span className="block truncate text-[11px] text-faint" title={client.mac}>
          {meta || client.mac}
        </span>
      </div>
      <VlanChip vlanId={client.vlanId} vlans={vlans} size="xs" showName={false} />
      <Signal dbm={client.signal} quality={client.quality} compact />
    </li>
  )
}
