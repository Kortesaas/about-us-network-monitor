import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react'
import { cn } from '@/ui/cn'
import { formatBps, formatTime } from '@/utils/format'

export type RatePoint = { t: number; values: (number | null)[] }
export type RateSeries = { label: string; color: string }

/** Series colours validated for both themes (download blue, upload orange); see docs/polling.md. */
export const RATE_COLORS = {
  light: ['#2f6feb', '#c2410c'],
  dark: ['#4f86e8', '#c98220'],
} as const

const PAD = { top: 10, right: 12, bottom: 22, left: 52 }

/**
 * Throughput over time. One y-axis, bits per second, 2px lines with a faint fill,
 * recessive grid, crosshair + tooltip on hover, legend when there is more than
 * one series, and the last value labelled directly at the line end.
 */
export function RateChart({
  series,
  points,
  height = 160,
  dark,
  className,
  emptyText = 'No samples yet',
}: {
  series: RateSeries[]
  points: RatePoint[]
  height?: number
  dark: boolean
  className?: string
  emptyText?: string
}) {
  const id = useId()
  const [hover, setHover] = useState<number | null>(null)
  // Draw in CSS pixels: the SVG's coordinate system follows the container width, so text keeps its
  // size at any width and the pointer maps 1:1 onto the plot (a fixed viewBox gets letterboxed).
  const container = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(640)
  useEffect(() => {
    const element = container.current
    if (!element) return
    const update = () => setWidth(Math.max(240, Math.round(element.getBoundingClientRect().width)))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const plot = { x: PAD.left, y: PAD.top, w: width - PAD.left - PAD.right, h: height - PAD.top - PAD.bottom }
  const scale = useMemo(() => {
    const t0 = points[0]?.t ?? 0
    const t1 = points[points.length - 1]?.t ?? 1
    const max = Math.max(1, ...points.flatMap((point) => point.values.map((value) => value ?? 0)))
    const niceMax = niceCeil(max)
    const x = (t: number) => plot.x + (t1 === t0 ? plot.w / 2 : ((t - t0) / (t1 - t0)) * plot.w)
    const y = (value: number) => plot.y + plot.h - (value / niceMax) * plot.h
    return { t0, t1, niceMax, x, y }
  }, [points, plot.x, plot.y, plot.w, plot.h])

  if (points.length < 2)
    return (
      <div className={cn('grid place-items-center rounded-md border border-dashed border-line text-[12px] text-faint', className)} style={{ height }}>
        {emptyText}
      </div>
    )

  const gridColor = dark ? 'rgba(255,255,255,0.07)' : 'rgba(15,23,42,0.08)'
  const axisText = 'var(--text-faint)'
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * scale.niceMax)
  const xTicks = timeTicks(scale.t0, scale.t1, 5)
  const paths = series.map((_, index) => {
    const segs: string[] = []
    let open = false
    for (const point of points) {
      const value = point.values[index]
      if (value === null || value === undefined) {
        open = false
        continue
      }
      segs.push(`${open ? 'L' : 'M'} ${scale.x(point.t).toFixed(1)} ${scale.y(value).toFixed(1)}`)
      open = true
    }
    const line = segs.join(' ')
    // Fill only continuous runs; a gap in the data stays a gap.
    const area = segs.length
      ? `${line} L ${scale.x(lastDefined(points, index)?.t ?? scale.t1).toFixed(1)} ${(plot.y + plot.h).toFixed(1)} L ${scale.x(firstDefined(points, index)?.t ?? scale.t0).toFixed(1)} ${(plot.y + plot.h).toFixed(1)} Z`
      : ''
    return { line, area }
  })
  const hovered = hover !== null ? points[hover] : null

  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const px = event.clientX - rect.left
    const t = scale.t0 + ((px - plot.x) / plot.w) * (scale.t1 - scale.t0)
    let best = 0
    let bestDist = Infinity
    points.forEach((point, index) => {
      const dist = Math.abs(point.t - t)
      if (dist < bestDist) {
        bestDist = dist
        best = index
      }
    })
    setHover(best)
  }

  return (
    <div ref={container} className={cn('relative', className)}>
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="block" style={{ height }} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={series.map((item) => item.label).join(' and ')}>
        <defs>
          {series.map((item, index) => (
            <linearGradient key={index} id={`${id}-fill-${index}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={item.color} stopOpacity={dark ? 0.22 : 0.16} />
              <stop offset="1" stopColor={item.color} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={plot.x} x2={plot.x + plot.w} y1={scale.y(tick)} y2={scale.y(tick)} stroke={gridColor} strokeWidth={1} />
            <text x={plot.x - 6} y={scale.y(tick) + 3.5} textAnchor="end" fontSize={10} fill={axisText} className="tabular">
              {tick === 0 ? '0' : formatBps(tick)}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={t} x={scale.x(t)} y={height - 7} textAnchor="middle" fontSize={10} fill={axisText} className="tabular">
            {formatTime(new Date(t).toISOString()).slice(0, 5)}
          </text>
        ))}
        {paths.map((path, index) => (
          <g key={index}>
            {path.area && <path d={path.area} fill={`url(#${id}-fill-${index})`} />}
            <path d={path.line} fill="none" stroke={series[index]!.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          </g>
        ))}
        {series.map((item, index) => {
          const last = lastDefined(points, index)
          if (!last) return null
          const value = last.values[index]!
          return (
            <g key={`end-${index}`}>
              <circle cx={scale.x(last.t)} cy={scale.y(value)} r={3.5} fill={item.color} stroke="var(--surface)" strokeWidth={2} />
            </g>
          )
        })}
        {hovered && (
          <g>
            <line x1={scale.x(hovered.t)} x2={scale.x(hovered.t)} y1={plot.y} y2={plot.y + plot.h} stroke={dark ? 'rgba(255,255,255,0.35)' : 'rgba(15,23,42,0.35)'} strokeWidth={1} strokeDasharray="3 3" />
            {series.map((item, index) => {
              const value = hovered.values[index]
              return value === null || value === undefined ? null : <circle key={index} cx={scale.x(hovered.t)} cy={scale.y(value)} r={4} fill={item.color} stroke="var(--surface)" strokeWidth={2} />
            })}
          </g>
        )}
      </svg>
      {hovered && (
        <div
          className="pointer-events-none absolute top-1 rounded-md border border-line bg-surface px-2 py-1 text-[11px] shadow-card"
          style={{ left: `${Math.min(80, Math.max(2, ((scale.x(hovered.t) - plot.x) / plot.w) * 100))}%`, transform: 'translateX(-50%)' }}
        >
          <p className="tabular text-faint">{formatTime(new Date(hovered.t).toISOString())}</p>
          {series.map((item, index) => (
            <p key={index} className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="h-2 w-2 rounded-sm" style={{ background: item.color }} />
              <span className="text-muted">{item.label}</span>
              <span className="tabular ml-auto pl-2 text-ink">{hovered.values[index] === null || hovered.values[index] === undefined ? '—' : formatBps(hovered.values[index]!)}</span>
            </p>
          ))}
        </div>
      )}
      {series.length > 1 && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
          {series.map((item, index) => {
            const last = lastDefined(points, index)
            return (
              <span key={index} className="flex items-center gap-1.5">
                <span className="h-0.5 w-3 rounded" style={{ background: item.color }} />
                {item.label}
                {last && <span className="tabular text-ink">{formatBps(last.values[index]!)}</span>}
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}

function lastDefined(points: RatePoint[], index: number) {
  for (let i = points.length - 1; i >= 0; i -= 1) if (points[i]!.values[index] !== null && points[i]!.values[index] !== undefined) return points[i]
  return null
}
function firstDefined(points: RatePoint[], index: number) {
  return points.find((point) => point.values[index] !== null && point.values[index] !== undefined) ?? null
}

/** Round up to 1/2/5 × 10^n so the top grid line is a readable number. */
function niceCeil(value: number) {
  const exp = Math.pow(10, Math.floor(Math.log10(value)))
  const mantissa = value / exp
  const nice = mantissa <= 1 ? 1 : mantissa <= 2 ? 2 : mantissa <= 5 ? 5 : 10
  return nice * exp
}

function timeTicks(t0: number, t1: number, count: number) {
  if (t1 <= t0) return [t0]
  const span = t1 - t0
  const steps = [60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000]
  const step = steps.find((candidate) => span / candidate <= count) ?? steps[steps.length - 1]!
  const ticks: number[] = []
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) ticks.push(t)
  return ticks
}
