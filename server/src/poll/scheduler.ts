import type { JobStatus, ScanStatus } from '@shared/types'
import { log } from '../logger.js'

const logger = log('scheduler')

export type JobSpec = {
  id: string
  label: string
  /** 0 = only runs when requested. */
  intervalMs: number
  /** Hard floor between two starts, even on manual refresh. */
  minGapMs: number
  /** Jobs in the same pool share a concurrency limit (e.g. SNMP). */
  pool?: string
  run: () => Promise<void>
}

type Job = JobSpec & {
  running: boolean
  queued: boolean
  lastStartedAt: number | null
  lastFinishedAt: number | null
  lastDurationMs: number | null
  lastError: string | null
  nextDueAt: number | null
  runs: number
  failures: number
}

/**
 * Owns every bit of polling in the process. One tick per second starts the
 * jobs that are due, never lets a job overlap itself, caps how many jobs of a
 * pool run at once, and enforces a minimum gap so "refresh" buttons cannot
 * turn into a flood.
 */
export class Scheduler {
  private jobs = new Map<string, Job>()
  private timer: NodeJS.Timeout | null = null
  private poolLimits = new Map<string, number>()
  private lastRequestedAt: number | null = null
  private listeners = new Set<() => void>()

  setPoolLimit(pool: string, limit: number) {
    this.poolLimits.set(pool, Math.max(1, limit))
  }

  onChange(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  add(spec: JobSpec, initialDelayMs = 0) {
    this.jobs.set(spec.id, {
      ...spec,
      running: false,
      queued: false,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastDurationMs: null,
      lastError: null,
      nextDueAt: spec.intervalMs > 0 || initialDelayMs > 0 ? Date.now() + initialDelayMs : null,
      runs: 0,
      failures: 0,
    })
  }

  remove(id: string) {
    this.jobs.delete(id)
  }

  has(id: string) {
    return this.jobs.has(id)
  }

  /** Changes cadence without restarting anything (settings edits). */
  setInterval(id: string, intervalMs: number) {
    const job = this.jobs.get(id)
    if (!job) return
    job.intervalMs = intervalMs
    if (intervalMs > 0 && job.lastFinishedAt !== null)
      job.nextDueAt = Math.min(job.nextDueAt ?? Infinity, job.lastFinishedAt + intervalMs)
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), 1000)
    this.timer.unref()
    this.tick()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Marks matching jobs as due now; they still respect minGap and pool limits. */
  request(predicate: (id: string) => boolean): string[] {
    this.lastRequestedAt = Date.now()
    const queued: string[] = []
    for (const job of this.jobs.values()) {
      if (!predicate(job.id)) continue
      job.queued = true
      queued.push(job.id)
    }
    this.notify()
    this.tick()
    return queued
  }

  private runningInPool(pool: string) {
    let count = 0
    for (const job of this.jobs.values()) if (job.running && job.pool === pool) count += 1
    return count
  }

  private tick() {
    const now = Date.now()
    for (const job of this.jobs.values()) {
      if (job.running) continue
      const due = job.queued || (job.nextDueAt !== null && now >= job.nextDueAt)
      if (!due) continue
      if (job.lastStartedAt !== null && now - job.lastStartedAt < job.minGapMs) continue
      if (job.pool && this.runningInPool(job.pool) >= (this.poolLimits.get(job.pool) ?? 1)) continue
      void this.execute(job)
    }
  }

  private async execute(job: Job) {
    job.running = true
    job.queued = false
    job.lastStartedAt = Date.now()
    this.notify()
    try {
      await job.run()
      if (job.lastError) logger.info(`${job.label} recovered`)
      job.lastError = null
    } catch (error) {
      job.failures += 1
      const message = error instanceof Error ? error.message : String(error)
      // Log a failure once, not every 30 s for as long as a switch stays offline; repeats go to debug.
      if (message !== job.lastError) logger.warn(`${job.label} failed: ${message}`)
      else logger.debug(`${job.label} still failing: ${message}`)
      job.lastError = message
    } finally {
      job.runs += 1
      job.running = false
      job.lastFinishedAt = Date.now()
      job.lastDurationMs = job.lastFinishedAt - job.lastStartedAt
      job.nextDueAt = job.intervalMs > 0 ? job.lastFinishedAt + job.intervalMs : null
      this.notify()
    }
  }

  private notify() {
    for (const listener of this.listeners) listener()
  }

  status(): ScanStatus {
    const jobs: JobStatus[] = [...this.jobs.values()].map((job) => ({
      id: job.id,
      label: job.label,
      intervalSeconds: Math.round(job.intervalMs / 1000),
      running: job.running,
      queued: job.queued,
      lastStartedAt: iso(job.lastStartedAt),
      lastFinishedAt: iso(job.lastFinishedAt),
      lastDurationMs: job.lastDurationMs,
      lastError: job.lastError,
      nextDueAt: iso(job.nextDueAt),
      runs: job.runs,
      failures: job.failures,
    }))
    const running = jobs.filter((job) => job.running)
    return {
      jobs,
      busy: running.length > 0,
      activity: running.length ? running.map((job) => job.label).join(' · ') : null,
      lastRequestedAt: iso(this.lastRequestedAt),
    }
  }
}

const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString())
