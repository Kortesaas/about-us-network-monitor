import { describe, expect, it, vi } from 'vitest'
import { Scheduler } from '../src/poll/scheduler.js'

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms)

describe('scheduler', () => {
  it('never overlaps a job with itself and honours the minimum gap', async () => {
    vi.useFakeTimers()
    const scheduler = new Scheduler()
    let running = 0
    let maxRunning = 0
    let runs = 0
    scheduler.add({
      id: 'a',
      label: 'A',
      intervalMs: 1000,
      minGapMs: 5000,
      run: async () => {
        running += 1
        runs += 1
        maxRunning = Math.max(maxRunning, running)
        await new Promise((resolve) => setTimeout(resolve, 3000))
        running -= 1
      },
    })
    scheduler.start()
    await tick(100)
    scheduler.request(() => true)
    scheduler.request(() => true)
    await tick(12_000)
    scheduler.stop()
    expect(maxRunning).toBe(1)
    // 0 s, then not before 5 s (gap), then ~10 s.
    expect(runs).toBeLessThanOrEqual(3)
    expect(runs).toBeGreaterThanOrEqual(2)
    vi.useRealTimers()
  })

  it('limits concurrency per pool', async () => {
    vi.useFakeTimers()
    const scheduler = new Scheduler()
    scheduler.setPoolLimit('snmp', 2)
    let running = 0
    let maxRunning = 0
    for (const id of ['a', 'b', 'c', 'd'])
      scheduler.add({
        id,
        label: id,
        intervalMs: 0,
        minGapMs: 0,
        pool: 'snmp',
        run: async () => {
          running += 1
          maxRunning = Math.max(maxRunning, running)
          await new Promise((resolve) => setTimeout(resolve, 500))
          running -= 1
        },
      })
    scheduler.start()
    scheduler.request(() => true)
    await tick(3000)
    scheduler.stop()
    expect(maxRunning).toBe(2)
    expect(scheduler.status().jobs.every((job) => job.runs === 1)).toBe(true)
    vi.useRealTimers()
  })

  it('records failures without stopping the schedule', async () => {
    vi.useFakeTimers()
    const scheduler = new Scheduler()
    scheduler.add({ id: 'x', label: 'X', intervalMs: 1000, minGapMs: 0, run: async () => { throw new Error('boom') } })
    scheduler.start()
    await tick(2500)
    scheduler.stop()
    const job = scheduler.status().jobs[0]!
    expect(job.failures).toBeGreaterThanOrEqual(2)
    expect(job.lastError).toBe('boom')
    expect(job.running).toBe(false)
    vi.useRealTimers()
  })
})
