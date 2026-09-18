import { ChevronDown } from 'lucide-react'
import { Button } from '@/ui/kit'

/** Footer for long lists: how many are shown, a button for the next page, and a way back to the top. */
export function LoadMore({ shown, total, step, onMore, onReset }: { shown: number; total: number; step: number; onMore: () => void; onReset?: () => void }) {
  if (total <= shown && shown <= step) return null
  const remaining = Math.max(0, total - shown)
  return (
    <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-[11px] text-faint">
      <span className="tabular">
        {Math.min(shown, total)} of {total}
      </span>
      <span className="flex items-center gap-1.5">
        {remaining > 0 && (
          <Button size="sm" variant="ghost" onClick={onMore}>
            <ChevronDown size={12} /> {Math.min(step, remaining)} more
          </Button>
        )}
        {shown > step && onReset && (
          <Button size="sm" variant="ghost" onClick={onReset}>
            Collapse
          </Button>
        )}
      </span>
    </div>
  )
}
