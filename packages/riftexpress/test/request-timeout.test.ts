import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { RiftexApp } from '../src/app.ts'
import { RiftexContext } from '../src/context/context.ts'
import { RiftexTimeoutError } from '../src/errors.ts'
import type { ListeningServer } from '../src/transport/types.ts'

/**
 * `requestTimeoutMs` enforces a wall-clock ceiling on a single request's
 * dispatch. When exceeded, the framework rejects with `RiftexTimeoutError`,
 * the default boundary writes a 503, and the orphaned handler — which
 * cannot be cancelled in JS — is detected via an AsyncLocalStorage-bound
 * epoch guard so its late writes never corrupt the next request bound to
 * the same pooled context.
 */

function url(server: ListeningServer, path: string): string {
  return `http://127.0.0.1:${server.port}${path}`
}

/** Tiny dispatch helper — populates the request side and runs `app.handle`. */
async function dispatch(
  app: RiftexApp,
  method: string,
  path: string,
): Promise<RiftexContext> {
  const ctx = new RiftexContext()
  ctx.method = method as RiftexContext['method']
  ctx.url = path
  ctx.path = path.split('?')[0] ?? '/'
  ctx.rawQuery = path.includes('?') ? (path.split('?')[1] ?? '') : ''
  await app.handle(ctx)
  return ctx
}

// ───────────────────────────────────────────────────────────────────────────
// Happy path
// ───────────────────────────────────────────────────────────────────────────

describe('requestTimeoutMs: handler resolves before timeout', () => {
  it('returns 200 with the handler body', async () => {
    const app = new RiftexApp({ requestTimeoutMs: 200 })
    app.get('/', (ctx) => ctx.json({ ok: true }))
    const ctx = await dispatch(app, 'GET', '/')
    expect(ctx._statusCode).toBe(200)
    expect(ctx._body).toMatchObject({ kind: 'string', data: JSON.stringify({ ok: true }) })
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Timeout fires → 503
// ───────────────────────────────────────────────────────────────────────────

describe('requestTimeoutMs: handler hangs forever', () => {
  it('produces 503 REQUEST_TIMEOUT within ~100ms of the configured deadline', async () => {
    const app = new RiftexApp({ requestTimeoutMs: 50 })
    app.get('/slow', () => new Promise<void>(() => {})) // never resolves
    const start = Date.now()
    const ctx = await dispatch(app, 'GET', '/slow')
    const elapsed = Date.now() - start
    expect(ctx._statusCode).toBe(503)
    expect(elapsed).toBeLessThan(150)
    const body = ctx._body as { kind: 'string'; data: string }
    const payload = JSON.parse(body.data) as { error: string; code: string }
    expect(payload.code).toBe('REQUEST_TIMEOUT')
    expect(payload.error).toMatch(/50ms/)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Default boundary serialization
// ───────────────────────────────────────────────────────────────────────────

describe('requestTimeoutMs: default error boundary serializes RiftexTimeoutError', () => {
  it('writes { error, code: REQUEST_TIMEOUT } as JSON', async () => {
    const app = new RiftexApp({ requestTimeoutMs: 25 })
    app.get('/x', () => new Promise<void>(() => {}))
    const ctx = await dispatch(app, 'GET', '/x')
    expect(ctx._statusCode).toBe(503)
    expect(ctx.getHeader('content-type')).toMatch(/application\/json/)
    const body = ctx._body as { kind: 'string'; data: string }
    const payload = JSON.parse(body.data) as Record<string, unknown>
    expect(payload).toMatchObject({ code: 'REQUEST_TIMEOUT' })
    expect(typeof payload.error).toBe('string')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Custom onError can override the timeout response
// ───────────────────────────────────────────────────────────────────────────

describe('requestTimeoutMs: onError can intercept the timeout', () => {
  it('user handler can rewrite the status / body', async () => {
    const app = new RiftexApp({ requestTimeoutMs: 25 })
    app.get('/x', () => new Promise<void>(() => {}))
    app.onError((err, ctx) => {
      if (err instanceof RiftexTimeoutError) {
        ctx.json({ degraded: true, retryAfter: 1 }, 504)
        return
      }
      throw err
    })
    const ctx = await dispatch(app, 'GET', '/x')
    expect(ctx._statusCode).toBe(504)
    const body = ctx._body as { kind: 'string'; data: string }
    expect(JSON.parse(body.data)).toEqual({ degraded: true, retryAfter: 1 })
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Late-write protection — load-bearing
// ───────────────────────────────────────────────────────────────────────────

describe('requestTimeoutMs: late writes from orphaned handler do NOT corrupt next request', () => {
  it('orphan ctx.json() after timeout is swallowed; subsequent request returns its own correct body', async () => {
    // We need the SAME ctx to be reused for both requests — that's the
    // exact failure mode we're protecting against. Drive that by acquiring
    // from a 1-slot pool that always pops the same instance.
    const app = new RiftexApp({ poolSize: 1, requestTimeoutMs: 25 })

    // Capture the orphan's "release" promise so the test can await it,
    // then assert that the second request's body is unchanged afterward.
    let orphanRelease: ((value: unknown) => void) | null = null
    const orphanPromise = new Promise<unknown>((resolve) => {
      orphanRelease = resolve
    })

    app.get('/slow', async (ctx) => {
      // Wait until the test releases us — well after the timeout has fired
      // and the second request has already written its own response.
      await orphanPromise
      // This call MUST be detected as a stale orphan and swallowed.
      ctx.json({ orphan: 'leaked' }, 599)
    })
    app.get('/fast', (ctx) => ctx.json({ second: true }, 201))

    // Capture the warning from the swallow path so we can assert it fired.
    const warnings: string[] = []
    const warnHandler = (warn: Error & { name?: string }): void => {
      if (warn.name === 'RiftexLateWriteWarning') warnings.push(warn.message)
    }
    process.on('warning', warnHandler)

    // Reach the private pool — testing the exact recycle path is the whole
    // point of this test, so an unsafe cast is justified.
    const pool = (app as unknown as { pool: { acquire(): RiftexContext; release(c: RiftexContext): void } }).pool

    try {
      // Manually drive both requests through the SAME ctx, releasing
      // between them so the pool reuses it.
      const ctx1 = pool.acquire()
      ctx1.method = 'GET'
      ctx1.url = '/slow'
      ctx1.path = '/slow'
      ctx1.rawQuery = ''
      await app.handle(ctx1)
      expect(ctx1._statusCode).toBe(503)
      pool.release(ctx1)

      const ctx2 = pool.acquire()
      // Same instance (1-slot pool).
      expect(ctx2).toBe(ctx1)
      ctx2.method = 'GET'
      ctx2.url = '/fast'
      ctx2.path = '/fast'
      ctx2.rawQuery = ''
      await app.handle(ctx2)
      expect(ctx2._statusCode).toBe(201)
      const body2Before = (ctx2._body as { kind: 'string'; data: string }).data
      expect(JSON.parse(body2Before)).toEqual({ second: true })

      // NOW release the orphan. Its ctx.json call should be swallowed by
      // the still-installed late-write guard. Wait a tick for the orphan
      // continuation to run.
      orphanRelease?.(undefined)
      await new Promise((r) => setTimeout(r, 10))

      // The second request's response must be unchanged — orphan write
      // discarded.
      const body2After = (ctx2._body as { kind: 'string'; data: string }).data
      expect(body2After).toBe(body2Before)
      expect(ctx2._statusCode).toBe(201)

      // And we should have observed at least one late-write warning.
      expect(warnings.length).toBeGreaterThanOrEqual(1)
      expect(warnings[0]).toMatch(/Late response write after timeout/)
    } finally {
      process.off('warning', warnHandler)
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Default behavior (no timeout configured) — hangs forever
// ───────────────────────────────────────────────────────────────────────────

describe('requestTimeoutMs: undefined disables the race', () => {
  it('hangs as before — no auto-503 (regression sentinel)', async () => {
    const app = new RiftexApp() // no requestTimeoutMs
    app.get('/x', () => new Promise<void>(() => {}))
    const ctx = new RiftexContext()
    ctx.method = 'GET'
    ctx.url = '/x'
    ctx.path = '/x'
    // Race app.handle against a short timer — if the framework added a
    // surprise default timeout, app.handle would resolve and we'd see a
    // status code; if the race is correctly disabled, the timer wins.
    const result = await Promise.race([
      app.handle(ctx).then(() => 'handle-resolved' as const),
      new Promise<'timer'>((r) => setTimeout(() => r('timer'), 75)),
    ])
    expect(result).toBe('timer')
    expect(ctx._statusCode).toBe(200) // never written
    expect(ctx._written).toBe(false)
  }, 1000)
})

// ───────────────────────────────────────────────────────────────────────────
// Timer must `unref` so a fast handler doesn't keep the loop alive
// ───────────────────────────────────────────────────────────────────────────

describe('requestTimeoutMs: timer is unref()\'d', () => {
  it('the timeout setTimeout call returns a handle that gets .unref() invoked', async () => {
    // Spy on setTimeout. raceWithTimeout calls it ONCE per dispatch, and
    // immediately invokes .unref() on the returned timer handle — so a
    // fast-resolving handler with a long configured timeout doesn't keep
    // the event loop alive.
    const realSetTimeout = globalThis.setTimeout
    const unrefSpy = vi.fn()
    let timeoutHandleCount = 0
    globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      const h = realSetTimeout(fn, ms, ...(rest as [])) as ReturnType<typeof setTimeout>
      // Wrap .unref to observe; only the FIRST setTimeout per app.handle
      // call is the one inside raceWithTimeout (the dispatched handler is
      // synchronous). Filter by the configured ms to be safe.
      if (ms === 5_000) {
        timeoutHandleCount++
        const origUnref = h.unref.bind(h)
        h.unref = (() => {
          unrefSpy()
          return origUnref()
        }) as typeof h.unref
      }
      return h
    }) as typeof setTimeout
    try {
      const app = new RiftexApp({ requestTimeoutMs: 5_000 })
      app.get('/', (ctx) => ctx.json({ ok: true }))
      const ctx = new RiftexContext()
      ctx.method = 'GET'
      ctx.url = '/'
      ctx.path = '/'
      await app.handle(ctx)
      expect(ctx._statusCode).toBe(200)
      expect(timeoutHandleCount).toBe(1)
      expect(unrefSpy).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// e2e — verify the whole pipe over a real socket
// ───────────────────────────────────────────────────────────────────────────

describe('requestTimeoutMs: e2e over node:http', () => {
  let server: ListeningServer
  beforeAll(async () => {
    const app = new RiftexApp({ requestTimeoutMs: 50 })
    app.get('/fast', (ctx) => ctx.json({ ok: true }))
    app.get('/slow', () => new Promise<void>(() => {}))
    server = await app.listen(0, '127.0.0.1')
  })
  afterAll(() => server.close())

  it('fast handler returns 200', async () => {
    const res = await fetch(url(server, '/fast'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('slow handler returns 503 with REQUEST_TIMEOUT code', async () => {
    const res = await fetch(url(server, '/slow'))
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string; code: string }
    expect(body.code).toBe('REQUEST_TIMEOUT')
  })
})
