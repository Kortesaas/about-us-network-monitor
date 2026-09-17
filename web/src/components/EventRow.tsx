import { Link } from 'react-router-dom'
import type { MonitorEvent } from '@shared/types'
import { cn } from '@/ui/cn'
import { formatTime } from '@/utils/format'

const dot: Record<MonitorEvent['severity'], string> = { critical: 'bg-danger', warning: 'bg-warn', info: 'bg-accent', ok: 'bg-ok' }

export function EventRow({ event, showDate }: { event: MonitorEvent; showDate?: boolean }) {
  const inner = (
    <>
      <span className="tabular w-[64px] shrink-0 text-[11px] text-faint" title={new Date(event.at).toLocaleString()}>
        {showDate ? new Date(event.at).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' : ''}
        {formatTime(event.at)}
      </span>
      <span className={cn('mt-[5px] h-2 w-2 shrink-0 rounded-full', dot[event.severity])} />
      <span className="min-w-0 flex-1 text-[12px] leading-5 text-ink">{event.message}</span>
    </>
  )
  const className = 'flex items-start gap-2 rounded px-2 py-1'
  return event.subject ? (
    <Link to={event.subject.href} className={cn(className, 'hover:bg-surface-2')}>
      {inner}
    </Link>
  ) : (
    <div className={className}>{inner}</div>
  )
}
