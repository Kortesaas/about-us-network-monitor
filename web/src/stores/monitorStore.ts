import { create } from 'zustand'
import type { LiveMessage, MonitorState, ScanScope, ScanStatus } from '@shared/types'
import { api } from '@/api/client'

export type Connection = 'connecting' | 'live' | 'reconnecting' | 'offline'

type MonitorStore = {
  state: MonitorState | null
  scan: ScanStatus | null
  connection: Connection
  lastMessageAt: number | null
  error: string | null
  /** Wall clock that ticks every few seconds so "12s ago" labels stay honest without re-fetching. */
  now: number
  requesting: boolean
  start: () => void
  reload: () => Promise<void>
  requestScan: (scope: ScanScope) => Promise<void>
}

let source: EventSource | null = null
let fetchTimer: ReturnType<typeof setTimeout> | null = null
let watchdog: ReturnType<typeof setInterval> | null = null
let started = false

/**
 * The browser never scans anything. It keeps one SSE subscription open; the
 * backend announces new state versions and the store re-fetches `/api/state`.
 */
export const useMonitor = create<MonitorStore>((set, get) => ({
  state: null,
  scan: null,
  connection: 'connecting',
  lastMessageAt: null,
  error: null,
  now: Date.now(),
  requesting: false,

  start: () => {
    if (started) return
    started = true
    const scheduleFetch = (delay: number) => {
      if (fetchTimer) return
      fetchTimer = setTimeout(() => {
        fetchTimer = null
        void get().reload()
      }, delay)
    }
    const connect = () => {
      source?.close()
      source = new EventSource('/api/events')
      const touch = () => set({ lastMessageAt: Date.now(), connection: 'live', error: null })
      source.addEventListener('hello', () => {
        touch()
        scheduleFetch(0)
      })
      source.addEventListener('state', (event) => {
        touch()
        const message = JSON.parse((event as MessageEvent<string>).data) as LiveMessage & { type: 'state' }
        if (!get().state || message.version !== get().state?.version) scheduleFetch(200)
      })
      source.addEventListener('scan', (event) => {
        touch()
        const message = JSON.parse((event as MessageEvent<string>).data) as LiveMessage & { type: 'scan' }
        set({ scan: message.scan })
      })
      source.addEventListener('event', (event) => {
        touch()
        const message = JSON.parse((event as MessageEvent<string>).data) as LiveMessage & { type: 'event' }
        const current = get().state
        if (current) set({ state: { ...current, events: [message.event, ...current.events].slice(0, 200) } })
      })
      source.addEventListener('ping', touch)
      source.onerror = () => {
        set({ connection: get().state ? 'reconnecting' : 'offline' })
        // EventSource reconnects on its own; a full reload catches anything missed meanwhile.
        scheduleFetch(2000)
      }
    }
    connect()
    watchdog = setInterval(() => {
      const { lastMessageAt, connection } = get()
      set({ now: Date.now() })
      if (lastMessageAt && Date.now() - lastMessageAt > 45_000 && connection === 'live') {
        set({ connection: 'reconnecting' })
        connect()
      }
    }, 5000)
    window.addEventListener('online', () => connect())
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') scheduleFetch(0)
    })
  },

  reload: async () => {
    try {
      const state = await api.state()
      set({ state, scan: state.scan, error: null, now: Date.now(), connection: get().connection === 'offline' ? 'live' : get().connection })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), connection: get().state ? 'reconnecting' : 'offline' })
    }
  },

  requestScan: async (scope) => {
    set({ requesting: true })
    try {
      const result = await api.requestScan(scope)
      set({ scan: result.status })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      setTimeout(() => set({ requesting: false }), 600)
    }
  },
}))

export function stopMonitor() {
  source?.close()
  source = null
  if (watchdog) clearInterval(watchdog)
  started = false
}
