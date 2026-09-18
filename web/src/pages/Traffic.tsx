import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Activity, Globe, Table2 } from 'lucide-react'
import type { TrafficSeries, TrafficState } from '@shared/types'
import { api } from '@/api/client'
import { Page } from '@/app/Page'
import { LoadingState } from '@/components/Loading'
import { RATE_COLORS, RateChart, type RatePoint } from '@/components/RateChart'
import { Age, VlanChip } from '@/components/status'
import { useMonitor } from '@/stores/monitorStore'
import { isDarkTheme, useThemeStore } from '@/stores/themeStore'
import { cn } from '@/ui/cn'
import { EmptyState, Panel, Segmented } from '@/ui/kit'
import { formatBps } from '@/utils/format'

const RANGES = [
  { value: 15, label: '15 min' },
  { value: 60, label: '1 h' },
  { value: 180, label: '3 h' },
  { value: 0, label: 'All' },
]

/** Bytes/s samples → bit/s points for the chart, windowed to the selected range. */
function toPoints(series: TrafficSeries, rangeMinutes: number): RatePoint[] {
  const cutoff = rangeMinutes ? Date.now() - rangeMinutes * 60_000 : 0
  return series.samples.map((sample) => ({ t: Date.parse(sample.t), values: [sample.inBps * 8, sample.outBps * 8] })).filter((point) => point.t >= cutoff)
}

function summarize(points: RatePoint[], index: number) {
  const values = points.map((point) => point.values[index]).filter((value): value is number => value !== null && value !== undefined)
  if (!values.length) return { avg: null, peak: null }
  return { avg: values.reduce((sum, value) => sum + value, 0) / values.length, peak: Math.max(...values) }
}

export function TrafficPage() {
  const state = useMonitor((store) => store.state)
  const version = useMonitor((store) => store.state?.version)
  const theme = useThemeStore((store) => store.theme)
  const dark = isDarkTheme(theme)
  const [full, setFull] = useState<TrafficState | null>(null)
  const [range, setRange] = useState(15)
  const [table, setTable] = useState(false)

  // The state carries a short window; the page pulls the full history and refreshes it whenever the state moves on.
  useEffect(() => {
    let cancelled = false
    api
      .traffic()
      .then((data) => {
        if (!cancelled) setFull(data)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [version])

  const traffic = full ?? state?.traffic ?? null
  const colors = dark ? RATE_COLORS.dark : RATE_COLORS.light
  const wanSeries = traffic?.series.find((item) => item.kind === 'wan') ?? null
  const linkSeries = traffic?.series.find((item) => item.kind === 'router-link') ?? null
  const vlanSeries = useMemo(() => traffic?.series.filter((item) => item.kind === 'vlan') ?? [], [traffic])
  if (!state || !traffic) return <LoadingState />

  const wan = traffic.wan
  const wanPoints = wanSeries ? toPoints(wanSeries, range) : []

  return (
    <Page
      title="Traffic"
      description="Internet usage as measured on the router, and what the devices in each VLAN move through their switch ports."
      actions={
        <>
          <Segmented value={range} onChange={setRange} options={RANGES} />
          <button
            type="button"
            onClick={() => setTable((value) => !value)}
            className={cn('flex items-center gap-1 rounded-md border px-2 py-1 text-[12px]', table ? 'border-accent bg-accent-soft text-accent-text' : 'border-line text-muted hover:text-ink')}
            title="Show numbers instead of charts"
          >
            <Table2 size={13} /> Table
          </button>
        </>
      }
    >
      <div className={cn('grid gap-4', linkSeries && 'xl:grid-cols-2')}>
        <Panel
          title={
            <span className="flex items-center gap-2">
              <Globe size={14} className="text-faint" /> Internet
              {wan && (
                <span className="font-normal text-faint">
                  {wan.routerName}
                  {wan.interfaces.length ? ` · ${wan.interfaces.map((iface) => iface.name).join(', ')}` : ''}
                </span>
              )}
            </span>
          }
          actions={
            wan && (
              <span className="text-[11px] text-faint">
                measured <Age iso={wan.at} />
              </span>
            )
          }
          bodyClassName="p-3"
        >
          {!wan ? (
            <EmptyState
              icon={<Globe size={22} />}
              title="No router counters"
              description="WAN throughput is read from the router's SNMP interface counters. It appears once a router in the setup answers SNMP."
            />
          ) : wan.error && wan.inBps === null ? (
            <p className="text-[12px] text-warn">{wan.error}</p>
          ) : (
            <>
              <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-2 2xl:grid-cols-4">
                <Hero label="Download now" value={wan.inBps} color={colors[0]} />
                <Hero label="Upload now" value={wan.outBps} color={colors[1]} />
                <Hero label="Peak download" value={summarize(wanPoints, 0).peak} color={colors[0]} unit="bits" hint={RANGES.find((item) => item.value === range)?.label} />
                <Hero label="Peak upload" value={summarize(wanPoints, 1).peak} color={colors[1]} unit="bits" hint={RANGES.find((item) => item.value === range)?.label} />
              </div>
              {table ? (
                <SeriesTable series={wanSeries ? [wanSeries] : []} range={range} colors={colors} />
              ) : (
                <RateChart
                  dark={dark}
                  height={190}
                  series={[
                    { label: 'download', color: colors[0] },
                    { label: 'upload', color: colors[1] },
                  ]}
                  points={wanPoints}
                  emptyText="Collecting the first samples…"
                />
              )}
              {wan.interfaces.some((iface) => !iface.up) && (
                <p className="mt-2 text-[11px] text-warn">
                  Down:{' '}
                  {wan.interfaces
                    .filter((iface) => !iface.up)
                    .map((iface) => iface.name)
                    .join(', ')}
                </p>
              )}
            </>
          )}
        </Panel>

        {linkSeries && (
          <Panel
            title={
              <span className="flex items-center gap-2">
                <Activity size={14} className="text-faint" /> Router link
                <span className="font-normal text-faint">everything reaching the router{linkSeries.source ? ` · ${linkSeries.source}` : ''}</span>
              </span>
            }
            bodyClassName="p-3"
          >
            <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-2 2xl:grid-cols-4">
              <Hero label={`${linkSeries.inLabel} now`} value={linkSeries.inBps} color={colors[0]} />
              <Hero label={`${linkSeries.outLabel} now`} value={linkSeries.outBps} color={colors[1]} />
              <Hero label={`Peak ${linkSeries.inLabel}`} value={summarize(toPoints(linkSeries, range), 0).peak} color={colors[0]} unit="bits" hint={RANGES.find((item) => item.value === range)?.label} />
              <Hero label={`Peak ${linkSeries.outLabel}`} value={summarize(toPoints(linkSeries, range), 1).peak} color={colors[1]} unit="bits" hint={RANGES.find((item) => item.value === range)?.label} />
            </div>
            {table ? (
              <SeriesTable series={[linkSeries]} range={range} colors={colors} />
            ) : (
              <RateChart
                dark={dark}
                height={190}
                series={[
                  { label: linkSeries.inLabel, color: colors[0] },
                  { label: linkSeries.outLabel, color: colors[1] },
                ]}
                points={toPoints(linkSeries, range)}
              />
            )}
          </Panel>
        )}
      </div>

      <div className="mt-4">
        <div className="mb-1.5 flex items-baseline justify-between">
          <h3 className="text-[12px] font-semibold uppercase tracking-wider text-faint">Per VLAN</h3>
          <span className="text-[11px] text-faint">access ports of each VLAN plus Wi-Fi clients on its SSIDs · trunks not attributed</span>
        </div>
        {vlanSeries.length === 0 ? (
          <Panel>
            <EmptyState
              icon={<Activity size={22} />}
              title="No VLAN traffic yet"
              description="Per-VLAN throughput comes from the switches' port counters; it appears once a switch in the setup answers SNMP."
            />
          </Panel>
        ) : table ? (
          <Panel bodyClassName="p-0">
            <SeriesTable series={vlanSeries} range={range} colors={colors} />
          </Panel>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
            {vlanSeries.map((item) => (
              <Panel
                key={item.id}
                title={
                  <span className="flex items-center gap-2">
                    <VlanChip vlanId={item.vlanId} vlans={state.vlans} />
                    <span className="tabular font-normal text-muted">
                      {item.inBps !== null ? `↓ ${formatBps(item.inBps * 8)}` : '—'} · {item.outBps !== null ? `↑ ${formatBps(item.outBps * 8)}` : '—'}
                    </span>
                  </span>
                }
                actions={
                  <span className="flex items-center gap-2 text-[11px]">
                    <span className={cn('tabular', item.activePorts || item.wifiClients ? 'text-faint' : 'text-warn')}>
                      {[item.activePorts ? `${item.activePorts} port${item.activePorts === 1 ? '' : 's'}` : null, item.wifiClients ? `${item.wifiClients} Wi-Fi` : null].filter(Boolean).join(' · ') ||
                        (item.activePorts === null && item.wifiClients === null ? '' : 'nothing connected')}
                    </span>
                    <Link to={`/vlans?vlan=${item.vlanId}`} className="text-accent-text hover:underline">
                      ports
                    </Link>
                  </span>
                }
                bodyClassName="p-2"
              >
                <RateChart
                  dark={dark}
                  height={120}
                  series={[
                    { label: item.inLabel, color: colors[0] },
                    { label: item.outLabel, color: colors[1] },
                  ]}
                  points={toPoints(item, range)}
                />
              </Panel>
            ))}
          </div>
        )}
      </div>

      <p className="mt-4 text-[11px] leading-5 text-faint">
        Internet = the router's WAN interface counters every {traffic.wanIntervalSeconds} s. VLAN figures count what devices send and receive at their own switch ports, so multicast (Dante, sACN) that
        reaches many ports is counted at every port; what a VLAN sends to the internet is not separable without flow accounting on the router. History covers about{' '}
        {Math.round(traffic.historySeconds / 3600)} h and survives restarts.
      </p>
    </Page>
  )
}

function Hero({ label, value, color, unit = 'bytes', hint }: { label: string; value: number | null; color: string; unit?: 'bytes' | 'bits'; hint?: string }) {
  return (
    <div className="rounded-md border border-line bg-surface-2 px-3 py-2">
      <p className="flex items-center gap-1.5 text-[11px] text-muted">
        <span className="h-2 w-2 rounded-sm" style={{ background: color }} />
        {label}
        {hint && <span className="text-faint">· {hint}</span>}
      </p>
      <p className="tabular mt-0.5 text-lg font-semibold leading-none text-ink">{value === null ? '—' : formatBps(unit === 'bytes' ? value * 8 : value)}</p>
    </div>
  )
}

function SeriesTable({ series, range, colors }: { series: TrafficSeries[]; range: number; colors: readonly [string, string] }) {
  return (
    <table className="w-full text-left text-[12px]">
      <thead className="bg-surface-2 text-2xs uppercase tracking-wider text-faint">
        <tr>
          <th className="px-3 py-2 font-semibold">Series</th>
          <th className="px-3 py-2 font-semibold">Direction</th>
          <th className="px-3 py-2 text-right font-semibold">Now</th>
          <th className="px-3 py-2 text-right font-semibold">Average</th>
          <th className="px-3 py-2 text-right font-semibold">Peak</th>
        </tr>
      </thead>
      <tbody>
        {series.flatMap((item) => {
          const points = toPoints(item, range)
          return [0, 1].map((index) => {
            const stats = summarize(points, index)
            const now = index === 0 ? item.inBps : item.outBps
            return (
              <tr key={`${item.id}-${index}`} className="border-t border-line">
                <td className="px-3 py-1.5 text-ink">{index === 0 ? item.label : ''}</td>
                <td className="px-3 py-1.5">
                  <span className="flex items-center gap-1.5 text-muted">
                    <span className="h-2 w-2 rounded-sm" style={{ background: colors[index] }} /> {index === 0 ? item.inLabel : item.outLabel}
                  </span>
                </td>
                <td className="tabular px-3 py-1.5 text-right text-ink">{now === null ? '—' : formatBps(now * 8)}</td>
                <td className="tabular px-3 py-1.5 text-right text-muted">{stats.avg === null ? '—' : formatBps(stats.avg)}</td>
                <td className="tabular px-3 py-1.5 text-right text-muted">{stats.peak === null ? '—' : formatBps(stats.peak)}</td>
              </tr>
            )
          })
        })}
      </tbody>
    </table>
  )
}
