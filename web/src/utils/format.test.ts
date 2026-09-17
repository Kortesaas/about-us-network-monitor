import { describe, expect, it } from 'vitest'
import { formatAge, formatBps, formatDuration } from './format'

describe('format helpers', () => {
  it('renders ages relative to now', () => {
    const now = Date.parse('2026-09-16T10:00:00Z')
    expect(formatAge('2026-09-16T09:59:58Z', now)).toBe('just now')
    expect(formatAge('2026-09-16T09:59:20Z', now)).toBe('40s ago')
    expect(formatAge('2026-09-16T09:30:00Z', now)).toBe('30m ago')
    expect(formatAge('2026-09-15T08:00:00Z', now)).toBe('1d 2h ago')
    expect(formatAge(null, now)).toBe('never')
  })
  it('renders bit rates and durations', () => {
    expect(formatBps(512)).toBe('512 b/s')
    expect(formatBps(2_400_000)).toBe('2.4 Mb/s')
    expect(formatBps(1_200_000_000)).toBe('1.20 Gb/s')
    expect(formatDuration(3661)).toBe('1h 1m')
    expect(formatDuration(90_000)).toBe('1d 1h')
  })
})
