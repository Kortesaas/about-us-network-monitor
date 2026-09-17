import type { PortLayout, PortRole } from './types'

/** One column on a switch face: a top and (for two-row layouts) a bottom port. */
export type PortColumn<T> =
  | { kind: 'ports'; index: number; top: T | null; bottom: T | null; group: 'main' | 'sfp' }
  | { kind: 'spacer'; index: number; group: 'sfp' }

/**
 * Lays ports out as they physically sit on the switch: copper ports first,
 * then a gap, then the SFP cages. Two-row layouts pair port 1/2, 3/4, …:
 * `odd-even` puts the odd port on top, `bottom-up` puts it at the bottom.
 * Same algorithm as the label planner so both apps draw identical faces.
 */
export function buildPortColumns<T extends { number: number; role: PortRole }>(
  ports: T[],
  layout: PortLayout,
  totalPorts: number,
): PortColumn<T>[] {
  const byNumber = new Map(ports.map((port) => [port.number, port]))
  const sfpCount = ports.filter((port) => port.role === 'sfp').length
  const mainCount = Math.max(totalPorts - sfpCount, 0)
  const columns: PortColumn<T>[] = []
  const pair = (first: number, count: number, group: 'main' | 'sfp') => {
    if (layout === 'sequential') {
      for (let offset = 0; offset < count; offset += 1)
        columns.push({
          kind: 'ports',
          index: columns.length,
          top: byNumber.get(first + offset) ?? null,
          bottom: null,
          group,
        })
      return
    }
    for (let offset = 0; offset < Math.ceil(count / 2); offset += 1) {
      const odd = first + offset * 2
      const even = odd + 1 <= first + count - 1 ? odd + 1 : null
      const oddPort = byNumber.get(odd) ?? null
      const evenPort = even === null ? null : (byNumber.get(even) ?? null)
      columns.push({
        kind: 'ports',
        index: columns.length,
        top: layout === 'bottom-up' ? evenPort : oddPort,
        bottom: layout === 'bottom-up' ? oddPort : evenPort,
        group,
      })
    }
  }
  if (mainCount > 0) pair(1, mainCount, 'main')
  if (sfpCount > 0) {
    if (columns.length) columns.push({ kind: 'spacer', index: columns.length, group: 'sfp' })
    pair(mainCount + 1, sfpCount, 'sfp')
  }
  return columns
}

export const rowsForLayout = (layout: PortLayout) => (layout === 'sequential' ? 1 : 2)
