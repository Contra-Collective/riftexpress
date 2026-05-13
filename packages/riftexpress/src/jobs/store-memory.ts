import type { QueueStore } from './types.ts'

interface PendingEntry<TData> {
  id: string
  data: TData
  attempt: number
  /** When `> Date.now()`, the job is delayed (used by retries). */
  notBefore: number
}

interface InFlightEntry<TData> {
  id: string
  data: TData
  attempt: number
}

/**
 * In-process FIFO queue store. Backs {@link RiftexQueue} when no custom
 * store is supplied. Suitable for single-instance deployments and tests.
 *
 * Layout:
 *   - `pending`: ordered list of jobs ready to be picked up. Delayed jobs
 *      (post-retry backoff) sit here too — `next()` skips entries whose
 *      `notBefore` hasn't elapsed yet, so callers should poll on a timer.
 *   - `inFlight`: jobs that have been `next()`-ed but not yet `ack`/`retry`/`fail`-ed.
 *   - `failed`: dead-letter list. Persists until `clearFailed()` is called.
 *
 * No background timers — purely event-driven via the queue worker pool.
 */
export class MemoryQueueStore<TData> implements QueueStore<TData> {
  private readonly pending: PendingEntry<TData>[] = []
  private readonly inFlight: Map<string, InFlightEntry<TData>> = new Map()
  private readonly failed: { id: string; data: TData; attempt: number }[] = []
  private nextId = 1

  enqueue(data: TData): Promise<{ id: string }> {
    const id = String(this.nextId++)
    this.pending.push({ id, data, attempt: 1, notBefore: 0 })
    return Promise.resolve({ id })
  }

  next(): Promise<{ id: string; data: TData; attempt: number } | null> {
    const now = Date.now()
    // Find the first pending entry whose delay has elapsed.
    for (let i = 0; i < this.pending.length; i++) {
      const entry = this.pending[i]!
      if (entry.notBefore <= now) {
        this.pending.splice(i, 1)
        const inflight: InFlightEntry<TData> = {
          id: entry.id,
          data: entry.data,
          attempt: entry.attempt,
        }
        this.inFlight.set(entry.id, inflight)
        return Promise.resolve({ id: entry.id, data: entry.data, attempt: entry.attempt })
      }
    }
    return Promise.resolve(null)
  }

  ack(id: string): Promise<void> {
    this.inFlight.delete(id)
    return Promise.resolve()
  }

  retry(id: string, delayMs: number): Promise<void> {
    const entry = this.inFlight.get(id)
    if (!entry) return Promise.resolve()
    this.inFlight.delete(id)
    this.pending.push({
      id: entry.id,
      data: entry.data,
      attempt: entry.attempt + 1,
      notBefore: Date.now() + Math.max(0, delayMs),
    })
    return Promise.resolve()
  }

  fail(id: string): Promise<void> {
    const entry = this.inFlight.get(id)
    if (!entry) return Promise.resolve()
    this.inFlight.delete(id)
    this.failed.push({ id: entry.id, data: entry.data, attempt: entry.attempt })
    return Promise.resolve()
  }

  size(): Promise<number> {
    return Promise.resolve(this.pending.length)
  }

  failedCount(): Promise<number> {
    return Promise.resolve(this.failed.length)
  }

  /** @internal Used by `RiftexQueue.clearFailed()`. */
  clearFailed(): void {
    this.failed.length = 0
  }

  /** @internal Used by `RiftexQueue.drain()` to know if work is outstanding. */
  inFlightCount(): number {
    return this.inFlight.size
  }

  /** @internal Earliest `notBefore` of any pending entry, or `null` if none. */
  earliestPendingAt(): number | null {
    let min: number | null = null
    for (const e of this.pending) {
      if (min === null || e.notBefore < min) min = e.notBefore
    }
    return min
  }
}
