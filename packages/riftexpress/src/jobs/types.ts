/**
 * Background-job type surface for RiftExpress.
 *
 * The core abstraction is a {@link QueueStore} — a pluggable persistence layer
 * for FIFO jobs with retries and a dead-letter list. The default implementation
 * ({@link MemoryQueueStore}) keeps everything in process; a Redis adapter can
 * land later by simply implementing this interface.
 *
 * A {@link RiftexQueue} wraps a store with a worker pool, retry policy, and
 * pause/resume/drain controls; a {@link QueueRegistry} (held by `RiftexApp`)
 * indexes named queues so route handlers can enqueue from any code path.
 */

/**
 * Worker function for a registered queue. Throwing causes a retry per the
 * configured {@link RetryPolicy}; resolving means the job is `ack`'d.
 */
export type QueueWorker<TData> = (job: {
  /** Stable id assigned by the store at enqueue time. */
  id: string
  /** Job payload (the value passed to `add`). */
  data: TData
  /**
   * 1-indexed attempt counter. `1` on first delivery; incremented before each
   * retry. Use this in the worker to back off external calls or short-circuit
   * non-recoverable failures.
   */
  attempt: number
}) => unknown | Promise<unknown>

/**
 * Retry policy. The first attempt is included in the count: `attempts: 3`
 * means one initial try + two retries.
 */
export interface RetryPolicy {
  /** Total tries including the first delivery. Must be `>= 1`. */
  attempts: number
  /**
   * Delay (ms) before the NEXT attempt, given the attempt that just failed
   * (1-indexed). E.g. for `attempts: 3`, this is called with `1` then `2`.
   */
  backoffMs: (attempt: number) => number
}

/**
 * Options for {@link RiftexApp.queue}. All fields optional.
 *
 * @typeParam TData - shape of job payloads enqueued onto this queue
 */
export interface QueueOptions<TData> {
  /**
   * Max concurrent jobs processed in parallel by this queue's worker pool.
   * Default `1` (strict FIFO). Bump this for I/O-bound work.
   */
  concurrency?: number
  /**
   * Retry policy on worker throw. Numeric shorthand `n` is equivalent to
   * `{ attempts: n, backoffMs: exponential }`. Default: 3 attempts at
   * 100ms / 400ms / 1.6s.
   */
  retries?: number | RetryPolicy
  /**
   * Custom store. Default {@link MemoryQueueStore}. Implement this to back
   * the queue with Redis / Postgres / SQS / etc.
   */
  store?: QueueStore<TData>
  /**
   * Called once retries are exhausted, just before the job is moved to the
   * dead-letter list. Throwing here is logged and swallowed — the job is
   * still moved to the DLQ.
   */
  onFailed?: (job: FailedJob<TData>) => void | Promise<void>
}

/**
 * Pluggable persistence layer. The default {@link MemoryQueueStore} keeps
 * pending and failed jobs in arrays + an in-flight map. A Redis adapter
 * would map this onto LPUSH / BRPOPLPUSH / a processing list / a DLQ list.
 *
 * Implementations MUST guarantee at-least-once delivery (a `next()`-ed
 * job that is neither `ack`'d nor `retry`'d nor `fail`'d is considered
 * stuck and may be re-delivered by the store on its own schedule).
 */
export interface QueueStore<TData> {
  /** Append a job to the tail. Returns the assigned id. */
  enqueue(data: TData): Promise<{ id: string }>
  /**
   * Pop the next pending job and move it to the in-flight set. Returns
   * `null` when the queue is empty. The returned `attempt` reflects how
   * many times this job has been delivered (1 on first delivery).
   */
  next(): Promise<{ id: string; data: TData; attempt: number } | null>
  /** Mark an in-flight job as completed. Removes it from the store. */
  ack(id: string): Promise<void>
  /**
   * Re-enqueue the in-flight job for another attempt after `delayMs`.
   * The store MUST increment its internal attempt counter so the next
   * `next()` returns it with the bumped count.
   */
  retry(id: string, delayMs: number): Promise<void>
  /** Move the in-flight job to the dead-letter list. */
  fail(id: string): Promise<void>
  /** Number of pending (not in-flight, not failed) jobs. */
  size(): Promise<number>
  /** Number of jobs in the dead-letter list. */
  failedCount(): Promise<number>
}

/** Payload passed to {@link QueueOptions.onFailed} when retries are exhausted. */
export interface FailedJob<TData> {
  id: string
  data: TData
  /** Final attempt number (== `retries.attempts`). */
  attempt: number
  /** Whatever the worker threw on its last attempt. */
  lastError: unknown
}

/** Per-request handle returned by `ctx.queue(name)`. */
export interface JobHandle<TData = unknown> {
  /** Enqueue `data`. Resolves to the assigned job id. */
  add(data: TData): Promise<{ id: string }>
}

/**
 * Bookkeeping wrapper a {@link QueueRegistry} keeps for every registered
 * queue. Mostly useful for introspection / tests.
 */
export interface RegisteredQueue<TData = unknown> {
  name: string
  options: Required<Pick<QueueOptions<TData>, 'concurrency'>> & {
    retries: RetryPolicy
    onFailed: ((job: FailedJob<TData>) => void | Promise<void>) | undefined
  }
}
