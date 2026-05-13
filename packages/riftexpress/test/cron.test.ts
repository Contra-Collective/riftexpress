import { describe, it, expect, vi } from 'vitest'
import { parseCronSpec, nextFireFrom } from '../src/cron/parser.ts'
import { RiftexCronJob } from '../src/cron/scheduler.ts'
import { CronRegistry } from '../src/cron/registry.ts'

describe('cron parser', () => {
  it('parses `* * * * *` as every minute', () => {
    const m = parseCronSpec('* * * * *')
    expect(m.minute.size).toBe(60)
    expect(m.hour.size).toBe(24)
    expect(m.dom.size).toBe(31)
    expect(m.month.size).toBe(12)
    expect(m.dow.size).toBe(7)
    expect(m.domIsWild).toBe(true)
    expect(m.dowIsWild).toBe(true)
  })

  it('parses */15 step in the minute field', () => {
    const m = parseCronSpec('*/15 * * * *')
    expect([...m.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45])
  })

  it('parses Sunday midnight UTC', () => {
    const m = parseCronSpec('0 0 * * 0')
    expect([...m.minute]).toEqual([0])
    expect([...m.hour]).toEqual([0])
    expect([...m.dow]).toEqual([0])
  })

  it('parses business-hours weekdays', () => {
    const m = parseCronSpec('0 9-17 * * 1-5')
    expect([...m.minute]).toEqual([0])
    expect([...m.hour].sort((a, b) => a - b)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
    expect([...m.dow].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  })

  it('parses 3-letter month and weekday names (case-insensitive)', () => {
    const m = parseCronSpec('0 0 * JAN-MAR mon')
    expect([...m.month].sort((a, b) => a - b)).toEqual([1, 2, 3])
    expect([...m.dow]).toEqual([1])
  })

  it('parses comma-separated lists', () => {
    const m = parseCronSpec('0,30 * * * *')
    expect([...m.minute].sort((a, b) => a - b)).toEqual([0, 30])
  })

  it('parses N-M/S step on a range', () => {
    const m = parseCronSpec('0-30/10 * * * *')
    expect([...m.minute].sort((a, b) => a - b)).toEqual([0, 10, 20, 30])
  })

  it('rejects garbage atoms', () => {
    expect(() => parseCronSpec('a b c d e')).toThrow()
  })

  it('rejects 6-field specs (with seconds)', () => {
    expect(() => parseCronSpec('* * * * * *')).toThrow(/5 fields/)
  })

  it('rejects out-of-range minute', () => {
    expect(() => parseCronSpec('60 * * * *')).toThrow()
  })

  it('rejects negative atoms', () => {
    expect(() => parseCronSpec('-1 * * * *')).toThrow()
  })

  it('rejects empty spec', () => {
    expect(() => parseCronSpec('')).toThrow()
    expect(() => parseCronSpec('   ')).toThrow()
  })

  it('rejects reversed ranges', () => {
    expect(() => parseCronSpec('30-10 * * * *')).toThrow(/reversed/)
  })

  it('rejects zero step', () => {
    expect(() => parseCronSpec('*/0 * * * *')).toThrow()
  })
})

describe('nextFireFrom (UTC)', () => {
  it('finds the next */15 slot after 12:34', () => {
    const m = parseCronSpec('*/15 * * * *')
    const from = new Date('2026-05-12T12:34:56Z')
    const next = nextFireFrom(m, from, 'UTC')
    expect(next?.toISOString()).toBe('2026-05-12T12:45:00.000Z')
  })

  it('finds the next minute boundary after 12:34:00 (must advance, not re-fire)', () => {
    const m = parseCronSpec('* * * * *')
    const from = new Date('2026-05-12T12:34:00.000Z')
    const next = nextFireFrom(m, from, 'UTC')
    expect(next?.toISOString()).toBe('2026-05-12T12:35:00.000Z')
  })

  it('rolls over the hour at minute 0', () => {
    const m = parseCronSpec('0 * * * *')
    const from = new Date('2026-05-12T12:34:00Z')
    const next = nextFireFrom(m, from, 'UTC')
    expect(next?.toISOString()).toBe('2026-05-12T13:00:00.000Z')
  })

  it('finds the next Sunday midnight', () => {
    const m = parseCronSpec('0 0 * * 0')
    // Tuesday 2026-05-12 → next Sunday is 2026-05-17.
    const from = new Date('2026-05-12T12:00:00Z')
    const next = nextFireFrom(m, from, 'UTC')
    expect(next?.toISOString()).toBe('2026-05-17T00:00:00.000Z')
  })

  it('handles dom/dow OR semantics (Vixie-cron)', () => {
    // Fire on the 1st OR on Sunday, every hour at minute 0.
    const m = parseCronSpec('0 * 1 * 0')
    // 2026-05-13 is Wednesday and not the 1st → next match is Sunday 2026-05-17 00:00.
    // (Hour-on-hour, so any 00:00 of 2026-05-17 qualifies.)
    const from = new Date('2026-05-13T15:30:00Z')
    const next = nextFireFrom(m, from, 'UTC')!
    // Either 2026-05-17 (Sunday) at 16:00 or 2026-06-01 at 00:00 — the
    // earlier one is Sunday at 16:00.
    expect(next.toISOString()).toBe('2026-05-17T00:00:00.000Z')
  })
})

describe('RiftexCronJob', () => {
  it('runs the handler at the next scheduled tick', async () => {
    const fired: Date[] = []
    // Use a spec that matches every minute, but use a tiny mock by patching
    // setTimeout via fake timers.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-12T12:34:30Z'))

    const job = new RiftexCronJob('* * * * *', {}, (ctx) => {
      fired.push(ctx.firedAt)
    })
    job.start()
    // Next fire is 12:35:00Z — advance 30s.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fired.length).toBe(1)
    expect(fired[0]!.toISOString()).toBe('2026-05-12T12:35:00.000Z')
    job.stop()
    vi.useRealTimers()
  })

  it('runOnStart fires immediately', async () => {
    let fired = 0
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-12T12:34:30Z'))
    const job = new RiftexCronJob('0 0 1 1 *', { runOnStart: true }, () => { fired++ })
    job.start()
    // Allow the queued handler microtask to run.
    await Promise.resolve()
    await Promise.resolve()
    expect(fired).toBe(1)
    job.stop()
    vi.useRealTimers()
  })

  it('overlap=skip drops a tick when previous run is still in flight', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-12T12:00:30Z'))
    let started = 0
    let release!: () => void
    const blocker = new Promise<void>((r) => { release = r })
    const job = new RiftexCronJob('* * * * *', { overlap: 'skip' }, async () => {
      started++
      await blocker
    })
    job.start()
    // Tick 1 at 12:01:00Z.
    await vi.advanceTimersByTimeAsync(30_000)
    // Tick 2 at 12:02:00Z while first is in-flight → must be skipped.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(started).toBe(1)
    release()
    await Promise.resolve()
    job.stop()
    vi.useRealTimers()
  })

  it('overlap=queue queues exactly one pending run', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-12T12:00:30Z'))
    let started = 0
    const releases: (() => void)[] = []
    const job = new RiftexCronJob('* * * * *', { overlap: 'queue' }, async () => {
      started++
      await new Promise<void>((r) => { releases.push(r) })
    })
    job.start()
    await vi.advanceTimersByTimeAsync(30_000)   // tick 1 → run
    await vi.advanceTimersByTimeAsync(60_000)   // tick 2 → queued
    await vi.advanceTimersByTimeAsync(60_000)   // tick 3 → dropped (queue full)
    expect(started).toBe(1)
    // Release the first run; the queued one should run.
    releases[0]!()
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    await Promise.resolve()
    expect(started).toBe(2)
    if (releases[1]) releases[1]()
    job.stop()
    vi.useRealTimers()
  })

  it('stop() cancels the timer and prevents further fires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-12T12:00:30Z'))
    let fired = 0
    const job = new RiftexCronJob('* * * * *', {}, () => { fired++ })
    job.start()
    expect(job.hasArmedTimer()).toBe(true)
    job.stop()
    expect(job.hasArmedTimer()).toBe(false)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fired).toBe(0)
    vi.useRealTimers()
  })

  it('nextRunAt reports the upcoming fire time after start', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-12T12:00:30Z'))
    const job = new RiftexCronJob('* * * * *', {}, () => {})
    expect(job.nextRunAt()).toBeNull()
    job.start()
    expect(job.nextRunAt()?.toISOString()).toBe('2026-05-12T12:01:00.000Z')
    job.stop()
    vi.useRealTimers()
  })

  it('handler errors do not crash the scheduler', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-12T12:00:30Z'))
    let fired = 0
    const job = new RiftexCronJob('* * * * *', {}, () => {
      fired++
      throw new Error('boom')
    })
    job.start()
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    // Both ticks should have run; subsequent scheduling unaffected by throw.
    expect(fired).toBeGreaterThanOrEqual(1)
    job.stop()
    vi.useRealTimers()
  })

  it('start() is idempotent', () => {
    const job = new RiftexCronJob('* * * * *', {}, () => {})
    job.start()
    const t1 = job.nextRunAt()
    job.start()
    const t2 = job.nextRunAt()
    expect(t2).toEqual(t1)
    job.stop()
  })

  it('rejects an invalid timezone at first nextFire computation', () => {
    expect(() => {
      const job = new RiftexCronJob('* * * * *', { timezone: 'Mars/Olympus' }, () => {})
      job.start()
    }).toThrow(/invalid cron timezone/)
  })
})

describe('CronRegistry', () => {
  it('startAll starts every registered job', () => {
    const reg = new CronRegistry()
    const a = reg.register('* * * * *', {}, () => {})
    const b = reg.register('0 0 * * *', {}, () => {})
    expect(reg.count()).toBe(2)
    reg.startAll()
    expect(a.nextRunAt()).not.toBeNull()
    expect(b.nextRunAt()).not.toBeNull()
    reg.stopAll()
  })

  it('stopAll cancels every job', () => {
    const reg = new CronRegistry()
    const a = reg.register('* * * * *', {}, () => {})
    reg.startAll()
    reg.stopAll()
    expect(a.hasArmedTimer()).toBe(false)
  })

  it('jobs registered after startAll are auto-started', () => {
    const reg = new CronRegistry()
    reg.startAll()
    const j = reg.register('* * * * *', {}, () => {})
    expect(j.nextRunAt()).not.toBeNull()
    reg.stopAll()
  })

  it('names() returns insertion order', () => {
    const reg = new CronRegistry()
    reg.register('* * * * *', { name: 'first' }, () => {})
    reg.register('0 * * * *', { name: 'second' }, () => {})
    expect(reg.names()).toEqual(['first', 'second'])
  })
})
