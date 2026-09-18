import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Cable,
  Gauge,
  Menu,
  Monitor,
  Moon,
  PanelLeft,
  RefreshCw,
  Search,
  Server,
  Settings,
  Share2,
  Sun,
  Layers,
  Wifi,
  X,
} from 'lucide-react'
import { cn } from '@/ui/cn'
import { LogoMark } from '@/ui/Logo'
import { Badge, IconButton, Spinner } from '@/ui/kit'
import { useMonitor, type Connection } from '@/stores/monitorStore'
import { useThemeStore, type Theme } from '@/stores/themeStore'
import { HealthBadge, Age } from '@/components/status'
import { CommandPalette } from '@/app/CommandPalette'
import { useFavicon } from '@/app/useFavicon'

const nav = [
  { label: 'Overview', to: '/overview', icon: Gauge },
  { label: 'Problems', to: '/problems', icon: AlertTriangle, badge: 'problems' as const },
  { label: 'Devices', to: '/devices', icon: Server },
  { label: 'Switches & Ports', to: '/switches', icon: Cable },
  { label: 'Topology', to: '/topology', icon: Share2 },
  { label: 'VLANs', to: '/vlans', icon: Layers },
  { label: 'WLAN', to: '/wlan', icon: Wifi },
  { label: 'Traffic', to: '/traffic', icon: BarChart3 },
  { label: 'Events', to: '/events', icon: Activity },
  { label: 'Settings', to: '/settings', icon: Settings },
]

const titles: [string, string][] = [
  ['/overview', 'Overview'],
  ['/problems', 'Problems & Checks'],
  ['/devices/', 'Device'],
  ['/devices', 'Devices'],
  ['/switches/', 'Switch'],
  ['/switches', 'Switches & Ports'],
  ['/topology', 'Topology'],
  ['/vlans', 'VLANs'],
  ['/wlan', 'WLAN'],
  ['/traffic', 'Traffic'],
  ['/events', 'Events'],
  ['/settings', 'Settings & Inventory'],
]

function ThemeToggle() {
  const { theme, setTheme } = useThemeStore()
  const options: { value: Theme; icon: typeof Sun; label: string }[] = [
    { value: 'light', icon: Sun, label: 'Light theme' },
    { value: 'dark', icon: Moon, label: 'Dark theme' },
    { value: 'system', icon: Monitor, label: 'System theme' },
  ]
  return (
    <div className="flex h-7 items-center gap-0.5 rounded border border-line bg-surface-2 px-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => setTheme(option.value)}
          aria-label={option.label}
          aria-pressed={theme === option.value}
          title={option.label}
          className={cn('grid h-6 w-6 place-items-center rounded-sm transition-colors', theme === option.value ? 'bg-surface text-ink shadow-card' : 'text-faint hover:text-ink')}
        >
          <option.icon size={13} />
        </button>
      ))}
    </div>
  )
}

const connectionLabel: Record<Connection, { label: string; dot: string }> = {
  connecting: { label: 'Connecting…', dot: 'bg-faint' },
  live: { label: 'Live', dot: 'bg-ok pulse-ok' },
  reconnecting: { label: 'Reconnecting…', dot: 'bg-warn' },
  offline: { label: 'Backend unreachable', dot: 'bg-danger' },
}

function LiveStatus({ collapsed }: { collapsed: boolean }) {
  const { state, scan, connection } = useMonitor()
  const item = connectionLabel[connection]
  const busy = scan?.busy ?? false
  if (collapsed)
    return (
      <div className="flex flex-col items-center gap-2 py-1" title={`${item.label}${state ? ` · updated ${state.generatedAt}` : ''}`}>
        <span className={cn('h-2 w-2 rounded-full', item.dot)} />
        {busy && <Spinner size={12} className="text-accent" />}
      </div>
    )
  return (
    <div className="space-y-1 px-1 text-[11px] leading-4">
      <div className="flex items-center gap-1.5 text-ink">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', item.dot)} />
        <span className="font-medium">{item.label}</span>
        {state && (
          <span className="ml-auto text-faint">
            <Age iso={state.generatedAt} />
          </span>
        )}
      </div>
      <div className="flex min-h-4 items-center gap-1.5 text-faint">
        {busy ? (
          <>
            <Spinner size={11} className="shrink-0 text-accent" />
            <span className="truncate">{scan?.activity}</span>
          </>
        ) : (
          <span className="truncate">Polling idle · {state?.scan.jobs.length ?? 0} jobs scheduled</span>
        )}
      </div>
    </div>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('aboutus-monitor-sidebar') === 'collapsed'
    } catch {
      return false
    }
  })
  const [mobileOpen, setMobileOpen] = useState(false)
  const [palette, setPalette] = useState(false)
  const [noticesDismissed, setNoticesDismissed] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  const { state, connection, requestScan, requesting, scan, error } = useMonitor()
  useFavicon(connection, state?.summary.health ?? null)

  useEffect(() => {
    try {
      localStorage.setItem('aboutus-monitor-sidebar', collapsed ? 'collapsed' : 'open')
    } catch {
      /* ignore */
    }
  }, [collapsed])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if ((event.metaKey || event.ctrlKey) && key === 'k') {
        event.preventDefault()
        setPalette((value) => !value)
        return
      }
      const target = event.target
      const typing = target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
      if (typing) return
      if (key === '/' ) {
        event.preventDefault()
        setPalette(true)
      }
      const shortcuts: Record<string, string> = { o: '/overview', p: '/problems', d: '/devices', s: '/switches', t: '/topology', v: '/vlans', e: '/events' }
      if (event.key === 'g') {
        const next = (second: KeyboardEvent) => {
          const to = shortcuts[second.key.toLowerCase()]
          if (to) navigate(to)
          window.removeEventListener('keydown', next)
        }
        window.addEventListener('keydown', next, { once: true })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])

  const title = titles.find(([prefix]) => location.pathname.startsWith(prefix))?.[1] ?? 'Network Monitor'
  const problems = state ? state.summary.problemsCritical + state.summary.problemsWarning : 0

  return (
    <div className="flex h-full overflow-hidden">
      {mobileOpen && <button aria-label="Close navigation" onClick={() => setMobileOpen(false)} className="fixed inset-0 z-40 bg-black/50 lg:hidden" />}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex shrink-0 flex-col border-r border-line bg-surface transition-[width,transform] duration-150 lg:static lg:translate-x-0',
          collapsed ? 'w-[56px]' : 'w-[224px]',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-sm bg-ink text-[var(--surface)]">
            <LogoMark size={15} />
          </span>
          {!collapsed && (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11px] font-bold uppercase tracking-[0.12em] text-ink">ABOUTUS</span>
              <span className="block truncate text-[10px] leading-3 text-faint">Network Monitor</span>
            </span>
          )}
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-2" aria-label="Main">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={() => setMobileOpen(false)}
              title={collapsed ? item.label : undefined}
              className={({ isActive }) =>
                cn(
                  'mb-0.5 flex h-8 items-center gap-2.5 rounded px-2 text-[13px] font-medium transition-colors',
                  isActive ? 'bg-accent-soft text-accent-text' : 'text-muted hover:bg-surface-2 hover:text-ink',
                  collapsed && 'justify-center px-0',
                )
              }
            >
              <span className="relative shrink-0">
                <item.icon size={15} />
                {collapsed && item.badge === 'problems' && problems > 0 && <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-danger" />}
              </span>
              {!collapsed && <span className="truncate">{item.label}</span>}
              {!collapsed && item.badge === 'problems' && problems > 0 && (
                <span className={cn('tabular ml-auto rounded-sm px-1.5 text-2xs font-bold', state && state.summary.problemsCritical > 0 ? 'bg-danger-soft text-danger' : 'bg-warn-soft text-warn')}>{problems}</span>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="shrink-0 space-y-2 border-t border-line p-2">
          <LiveStatus collapsed={collapsed} />
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="hidden h-7 w-full items-center justify-center gap-2 rounded text-[12px] text-faint hover:bg-surface-2 hover:text-ink lg:flex"
          >
            <PanelLeft size={14} />
            {!collapsed && 'Collapse'}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
          <IconButton label="Open navigation" onClick={() => setMobileOpen(true)} className="lg:hidden">
            <Menu size={16} />
          </IconButton>
          <div className="flex min-w-0 items-baseline gap-2">
            <h1 className="truncate text-[13px] font-semibold text-ink">{title}</h1>
            <span className="hidden truncate text-[12px] text-faint sm:block">{state?.backend.hostname}</span>
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            {state && <HealthBadge health={state.summary.health} summary={state.summary} />}
            {connection !== 'live' && (
              <Badge tone={connection === 'offline' ? 'danger' : 'warn'} title={error ?? undefined}>
                {connectionLabel[connection].label}
              </Badge>
            )}

            <button
              type="button"
              onClick={() => setPalette(true)}
              className="hidden h-7 items-center gap-2 rounded border border-line bg-surface-2 px-2 text-[12px] text-faint transition-colors hover:border-line-strong hover:text-muted md:flex"
            >
              <Search size={13} />
              Find device, IP, MAC…
              <kbd className="rounded-sm border border-line bg-surface px-1 text-2xs">⌘K</kbd>
            </button>
            <IconButton label="Search" onClick={() => setPalette(true)} className="md:hidden">
              <Search size={15} />
            </IconButton>

            <button
              type="button"
              onClick={() => void requestScan('all')}
              disabled={requesting || connection === 'offline'}
              title="Ask the Pi to poll everything now. Cooldowns still apply — this never floods the network."
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded border border-line bg-surface-2 px-2 text-[12px] font-medium text-muted transition-colors hover:border-line-strong hover:text-ink disabled:opacity-50',
              )}
            >
              <RefreshCw size={13} className={cn((requesting || scan?.busy) && 'spin')} />
              <span className="hidden sm:inline">Refresh</span>
            </button>
            <ThemeToggle />
          </div>
        </header>

        {state?.backend.notices.length && !noticesDismissed ? (
          <div className="flex shrink-0 items-start gap-2 border-b border-line bg-warn-soft px-3 py-1.5 text-[12px] leading-4 text-warn">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              {state.backend.notices.map((notice) => (
                <p key={notice}>{notice}</p>
              ))}
            </div>
            <IconButton label="Dismiss" size="sm" onClick={() => setNoticesDismissed(true)} className="text-warn hover:bg-warn/10">
              <X size={13} />
            </IconButton>
          </div>
        ) : null}

        {/* stable gutter: the content width must not change when a page is short enough to lose its scrollbar */}
        <main className="min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable]">{children}</main>
      </div>

      {palette && <CommandPalette onClose={() => setPalette(false)} />}
    </div>
  )
}
