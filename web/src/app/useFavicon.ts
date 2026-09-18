import { useEffect } from 'react'
import type { Summary } from '@shared/types'
import type { Connection } from '@/stores/monitorStore'

export type FaviconStatus = 'starting' | 'ok' | 'problem'

const NODES = [
  { cx: 48.6, cy: 48.6 },
  { cx: 15.4, cy: 48.6 },
  { cx: 15.4, cy: 15.4 },
  { cx: 48.6, cy: 15.4 },
] as const

/**
 * The planner's black-on-white hub-and-spokes mark, unchanged, with one of the
 * four nodes replaced by the status dot. `position` picks which node (0 =
 * bottom right, then clockwise), so cycling it animates the tab icon.
 */
export function faviconSvg(status: FaviconStatus, position = 0) {
  const dot = status === 'ok' ? '#22c55e' : status === 'problem' ? '#ef4444' : '#f59e0b'
  const active = NODES[position % NODES.length]!
  const nodes = NODES.filter((node) => node !== active)
    .map((node) => `<circle cx="${node.cx}" cy="${node.cy}" r="6.9"/>`)
    .join('')
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    '<rect width="64" height="64" rx="14" fill="#ffffff"/>' +
    '<g fill="#000000"><g stroke="#000000" stroke-width="3.2" stroke-linecap="round"><path d="M32 32 15.4 15.4M32 32l16.6-16.6M32 32L15.4 48.6M32 32l16.6 16.6"/></g>' +
    `<circle cx="32" cy="32" r="8.5"/>${nodes}</g>` +
    `<circle cx="${active.cx}" cy="${active.cy}" r="11" fill="#ffffff"/><circle cx="${active.cx}" cy="${active.cy}" r="8" fill="${dot}"/>` +
    '</svg>'
  )
}

export function faviconStatus(connection: Connection, health: Summary['health'] | null): FaviconStatus {
  if (connection === 'offline') return 'problem'
  if (connection === 'connecting' || health === null || health === 'unknown') return 'starting'
  if (health === 'critical') return 'problem'
  if (health === 'degraded') return 'starting'
  return 'ok'
}

const href = (status: FaviconStatus, position: number) => `data:image/svg+xml;utf8,${encodeURIComponent(faviconSvg(status, position))}`

/**
 * Keeps the browser tab icon in sync with the monitor: yellow while
 * starting/degraded, green when healthy, red on problems or no backend. While
 * the live connection is up the dot walks around the four corners once a
 * second, so a frozen icon means a frozen page.
 */
export function useFavicon(connection: Connection, health: Summary['health'] | null) {
  const status = faviconStatus(connection, health)
  const animate = connection === 'live'
  useEffect(() => {
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (!link) {
      link = document.createElement('link')
      link.rel = 'icon'
      document.head.appendChild(link)
    }
    link.type = 'image/svg+xml'
    const frames = NODES.map((_, index) => href(status, index))
    let position = 0
    link.href = frames[0]!
    if (!animate) return
    const timer = setInterval(() => {
      if (document.hidden) return
      position = (position + 1) % frames.length
      link!.href = frames[position]!
    }, 1000)
    return () => clearInterval(timer)
  }, [status, animate])
}
