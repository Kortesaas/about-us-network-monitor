/** Hub-and-spokes mark shared with the planner, so both tools read as one family. */
export function LogoMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true" className={className}>
      <g stroke="currentColor" strokeWidth={1.2} strokeLinecap="round">
        <path d="M12 12 5.78 5.78M12 12l6.22-6.22M12 12l-6.22 6.22M12 12l6.22 6.22" />
      </g>
      <circle cx="12" cy="12" r="3.2" />
      <circle cx="5.78" cy="5.78" r="2.6" />
      <circle cx="18.22" cy="5.78" r="2.6" />
      <circle cx="5.78" cy="18.22" r="2.6" />
      <circle cx="18.22" cy="18.22" r="2.6" />
    </svg>
  )
}
