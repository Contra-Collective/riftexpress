import { nextFireFrom, parseCronSpec, type CronMatch } from './parser.ts'

/**
 * Handler signature for `app.cron(...)` jobs. Receives the scheduled fire
 * time AND a fresh `now` so handlers can detect drift / late starts.
 */
export type CronHandler = (ctx: { now: Date; firedAt: Date }) => unknown | Promise<unknown>

/** Options for {@link RiftexCronJob}. */
export interface CronOptions {
  /** IANA timezone for the spec. Default `'UTC'`. */
  timezone?: string
  /**
   * If `true`, fire once at `start()` BEFORE waiting for the next scheduled
   * slot. The synthetic `firedAt` for this immediate run is `now`. Default `false`.
   */
  runOnStart?: boolean
  /**
   * Behavior when a previous run is still in flight at the next fire time.
   *   - `'skip'`  → drop the new tick (default).
   *   - `'queue'` → queue ONE pending run; subsequent ticks during the same
   *      pile-up still drop. (We don't do unbounded queuing; that's an
   *      anti-pattern that hides bugs.)
   */
  overlap?: 'skip' | 'queue'
  /** Optional name for logs / introspection. Defaults to the original spec. */
  name?: string
}

/**
 * A single scheduled cron job. Owns its parsed spec, a `setTimeout`-based
 * one-shot rescheduler, and bookkeeping for in-flight runs.
 *
 * Lifecycle: `start()` arms the first timer; `stop()` cancels it. The
 * timer is `unref()`'d so a registered cron alone never keeps the event
 * loop alive — production apps that have an HTTP listener will keep
 * running normally; standalone scripts will exit when other work finishes.
 */
export class RiftexCronJob {
  readonly name: string
  readonly spec: string
  readonly timezone: string
  readonly overlap: 'skip' | 'queue'
  private readonly match: CronMatch
  private readonly handler: CronHandler
  private readonly runOnStart: boolean

  private timer: NodeJS.Timeout | null = null
  private inFlight = 0
  private queuedRun: { firedAt: Date } | null = null
  private nextAt: Date | null = null
  private started = false
  private stopped = false

  constructor(spec: string, opts: CronOptions, handler: CronHandler) {
    this.spec = spec
    this.match = parseCronSpec(spec)
    this.timezone = opts.timezone ?? 'UTC'
    this.overlap = opts.overlap ?? 'skip'
    this.runOnStart = opts.runOnStart ?? false
    this.name = opts.name ?? spec
    this.handler = handler
  }

  /** Arm the scheduler. Idempotent. */
  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    if (this.runOnStart) {
      // Fire immediately (synthetic `firedAt = now`), then schedule.
      this.dispatch(new Date())
    }
    this.scheduleNext()
  }

  /** Cancel the scheduler. In-flight runs continue until they naturally finish. */
  stop(): void {
    this.stopped = true
    this.started = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.queuedRun = null
    this.nextAt = null
  }

  /** Next scheduled fire time, or `null` if not started / stopped. */
  nextRunAt(): Date | null {
    return this.nextAt
  }

  /** Are there currently any in-flight invocations of the handler? */
  isRunning(): boolean {
    return this.inFlight > 0
  }

  /** @internal Test helper — does this job have its wake timer armed? */
  hasArmedTimer(): boolean {
    return this.timer !== null
  }

  private scheduleNext(): void {
    if (this.stopped) return
    const now = new Date()
    const next = nextFireFrom(this.match, now, this.timezone)
    if (!next) {
      // Spec matches nothing reachable — give up silently rather than spin.
      this.nextAt = null
      return
    }
    this.nextAt = next
    const delay = Math.max(1, next.getTime() - now.getTime())
    this.timer = setTimeout(() => {
      this.timer = null
      const firedAt = next
      this.dispatch(firedAt)
      this.scheduleNext()
    }, delay)
    this.timer.unref?.()
  }

  private dispatch(firedAt: Date): void {
    if (this.inFlight > 0) {
      // Overlap path. `'skip'` drops; `'queue'` records ONE pending run.
      if (this.overlap === 'queue' && this.queuedRun === null) {
        this.queuedRun = { firedAt }
      }
      return
    }
    this.runOnce(firedAt)
  }

  private runOnce(firedAt: Date): void {
    this.inFlight++
    void Promise.resolve()
      .then(() => this.handler({ now: new Date(), firedAt }))
      .catch(() => {
        // Cron handler errors are observation-only here; framework-level
        // logging belongs in the registry layer (or a user-supplied
        // `onError` if/when we add one). Do not crash the scheduler.
      })
      .finally(() => {
        this.inFlight--
        // If a queued run is waiting, drain it now.
        if (this.queuedRun !== null && this.inFlight === 0 && !this.stopped) {
          const pending = this.queuedRun
          this.queuedRun = null
          this.runOnce(pending.firedAt)
        }
      })
  }
}
