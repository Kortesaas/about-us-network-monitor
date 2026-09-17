import { Link } from 'react-router-dom'
import { ChevronRight, Lightbulb } from 'lucide-react'
import type { Problem } from '@shared/types'
import { cn } from '@/ui/cn'
import { Age, SeverityBadge } from '@/components/status'

const stripe: Record<Problem['severity'], string> = { critical: 'border-l-danger', warning: 'border-l-warn', info: 'border-l-accent' }

const dot: Record<Problem['severity'], string> = { critical: 'bg-danger', warning: 'bg-warn', info: 'bg-accent' }

/** One-line variant for dense lists: severity dot, title, jump link. */
export function ProblemRow({ problem }: { problem: Problem }) {
  return (
    <Link to={problem.subject.href} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-surface-2" title={`${problem.detail}\n\n${problem.suggestion}`}>
      <span className={cn('h-2 w-2 shrink-0 rounded-full', dot[problem.severity])} />
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">{problem.title}</span>
      <span className="shrink-0 text-[11px] text-faint">
        <Age iso={problem.since} />
      </span>
      <ChevronRight size={13} className="shrink-0 text-faint" />
    </Link>
  )
}

export function ProblemCard({ problem, expanded }: { problem: Problem; expanded?: boolean }) {
  return (
    <div className={cn('rounded-lg border border-line border-l-[3px] bg-surface p-3', stripe[problem.severity])}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={problem.severity} />
            <span className="text-[11px] text-faint">
              since <Age iso={problem.since} />
            </span>
          </div>
          <p className="mt-1.5 text-[13px] font-semibold leading-5 text-ink">{problem.title}</p>
          {expanded && (
            <>
              <p className="mt-1 text-[12px] leading-5 text-muted">{problem.detail}</p>
              <p className="mt-2 flex items-start gap-1.5 rounded bg-surface-2 px-2 py-1.5 text-[12px] leading-5 text-ink">
                <Lightbulb size={13} className="mt-1 shrink-0 text-warn" />
                <span>{problem.suggestion}</span>
              </p>
            </>
          )}
        </div>
        <Link to={problem.subject.href} className="mt-0.5 flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium text-accent-text hover:bg-accent-soft" title={problem.subject.label}>
          <span className="hidden max-w-[160px] truncate sm:inline">{problem.subject.label}</span>
          <ChevronRight size={13} />
        </Link>
      </div>
    </div>
  )
}
