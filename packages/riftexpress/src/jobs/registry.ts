import { RiftexQueue } from './queue.ts'
import type { QueueOptions, QueueWorker } from './types.ts'

/**
 * Maps queue names → {@link RiftexQueue} instances. Held by `RiftexApp`,
 * mirroring the shape of {@link CronRegistry}.
 *
 * Lookup is O(1). Names must be unique within an app — re-registering the
 * same name throws (mirrors how `app.get('/users')` would conflict if you
 * registered the same path twice with the same method).
 */
export class QueueRegistry {
  private readonly queues: Map<string, RiftexQueue<unknown>> = new Map()

  /**
   * Register a new queue. Returns the created instance. Throws if a queue
   * with `name` is already registered.
   */
  register<TData>(
    name: string,
    opts: QueueOptions<TData>,
    worker: QueueWorker<TData>,
  ): RiftexQueue<TData> {
    if (this.queues.has(name)) {
      throw new Error(`riftexpress: queue "${name}" is already registered`)
    }
    const queue = new RiftexQueue<TData>(name, opts, worker)
    this.queues.set(name, queue as unknown as RiftexQueue<unknown>)
    return queue
  }

  /** Look up a queue. Throws if not registered (typos surface immediately). */
  get<TData = unknown>(name: string): RiftexQueue<TData> {
    const queue = this.queues.get(name)
    if (!queue) {
      throw new Error(
        `riftexpress: queue "${name}" is not registered (call app.queue("${name}", ...) first)`,
      )
    }
    return queue as unknown as RiftexQueue<TData>
  }

  /** Has a queue with this name been registered? */
  has(name: string): boolean {
    return this.queues.has(name)
  }

  /** Number of registered queues. */
  count(): number {
    return this.queues.size
  }

  /** All registered queue names (insertion order). */
  names(): string[] {
    return [...this.queues.keys()]
  }

  /**
   * Start the worker pool of every registered queue. Called by the app's
   * composition step so workers don't process jobs before the app is ready.
   */
  startAll(): void {
    for (const q of this.queues.values()) q.start()
  }

  /**
   * Drain every queue concurrently. Resolves when all queues either finish
   * their in-flight work or hit `timeoutMs`. The returned object reports
   * which queues drained cleanly vs timed out — useful for shutdown logs.
   */
  async drainAll(timeoutMs?: number): Promise<{ clean: string[]; timedOut: string[] }> {
    const entries = [...this.queues.entries()]
    const results = await Promise.all(entries.map(([, q]) => q.drain(timeoutMs)))
    const clean: string[] = []
    const timedOut: string[] = []
    entries.forEach(([name], i) => {
      if (results[i]) clean.push(name)
      else timedOut.push(name)
    })
    return { clean, timedOut }
  }
}
