import { RiftexCronJob, type CronHandler, type CronOptions } from './scheduler.ts'

/**
 * Holds every registered {@link RiftexCronJob} for an app. Mirrors the shape
 * of `QueueRegistry` so the integration in `RiftexApp` is symmetric.
 *
 * Cron jobs are NOT auto-started on registration — `startAll()` runs at
 * compose time so handlers don't fire before the app is ready (e.g. before
 * `app.decorate()` plugins have wired up `ctx`-style state the handler may
 * inspect via the registry from another code path).
 */
export class CronRegistry {
  private readonly jobs: RiftexCronJob[] = []
  private started = false

  /** Register a new cron job. Returns the job for advanced introspection. */
  register(spec: string, opts: CronOptions, handler: CronHandler): RiftexCronJob {
    const job = new RiftexCronJob(spec, opts, handler)
    this.jobs.push(job)
    // If the registry has already been started (e.g. plugin registered a
    // cron after compose), start the new job immediately to match what
    // happened to all earlier-registered jobs.
    if (this.started) job.start()
    return job
  }

  /** Number of registered jobs. */
  count(): number {
    return this.jobs.length
  }

  /** All registered job names (insertion order). */
  names(): string[] {
    return this.jobs.map((j) => j.name)
  }

  /** Start every registered job. Idempotent. */
  startAll(): void {
    if (this.started) return
    this.started = true
    for (const j of this.jobs) j.start()
  }

  /** Stop every registered job. In-flight handlers continue until they finish. */
  stopAll(): void {
    this.started = false
    for (const j of this.jobs) j.stop()
  }
}
