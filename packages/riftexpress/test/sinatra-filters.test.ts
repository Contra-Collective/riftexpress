/**
 * Sinatra-style `before` / `after` filters on `RiftexApp`.
 *
 * `before` runs BEFORE the route handler (auto-invokes `next()`).
 * `after` runs AFTER the route handler resolves but before the wire write.
 * Pattern matching is boundary-respecting prefix match (reuses the same
 * rule the app uses for `app.use(prefix, mw)`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { riftex } from '../src/index.ts'
import {
  before as topBefore,
  after as topAfter,
  get as topGet,
  listen as topListen,
  _resetDefaultApp,
} from '../src/sinatra/top-level.ts'
import type { ListeningServer } from '../src/transport/types.ts'

const HOST = '127.0.0.1'

function url(server: ListeningServer, path: string): string {
  return `http://${HOST}:${server.port}${path}`
}

let server: ListeningServer | null = null

beforeEach(() => {
  _resetDefaultApp()
})

afterEach(async () => {
  if (server) {
    await server.close()
    server = null
  }
})

describe('before(): pattern-scoped pre-handler filter', () => {
  it('runs before route handlers under the matching prefix', async () => {
    const app = riftex()
    app.before('/admin/*', async (ctx, next) => {
      ctx.state.adminGate = true
      await next()
    })
    app.get('/admin/users', (ctx) => ({ gate: ctx.state.adminGate ?? false }))
    server = await app.listen(0, HOST)
    const res = await fetch(url(server, '/admin/users'))
    expect(await res.json()).toEqual({ gate: true })
  })

  it('does NOT fire for paths outside the prefix', async () => {
    const app = riftex()
    let adminFired = false
    app.before('/admin/*', async (ctx, next) => {
      adminFired = true
      ctx.state.adminGate = true
      await next()
    })
    app.get('/api/users', (ctx) => ({ gate: ctx.state.adminGate ?? false }))
    server = await app.listen(0, HOST)
    const res = await fetch(url(server, '/api/users'))
    expect(adminFired).toBe(false)
    expect(await res.json()).toEqual({ gate: false })
  })

  it('without a pattern, fires for every request (global)', async () => {
    const app = riftex()
    let hits = 0
    app.before(async (_ctx, next) => {
      hits++
      await next()
    })
    app.get('/a', () => 'a')
    app.get('/b', () => 'b')
    app.get('/c/d', () => 'cd')
    server = await app.listen(0, HOST)
    await fetch(url(server, '/a'))
    await fetch(url(server, '/b'))
    await fetch(url(server, '/c/d'))
    expect(hits).toBe(3)
  })

  it('multiple before filters at the same pattern run in registration order', async () => {
    const app = riftex()
    const order: string[] = []
    app.before('/x', async (_ctx, next) => {
      order.push('one')
      await next()
    })
    app.before('/x', async (_ctx, next) => {
      order.push('two')
      await next()
    })
    app.get('/x', () => {
      order.push('handler')
      return 'ok'
    })
    server = await app.listen(0, HOST)
    await fetch(url(server, '/x'))
    expect(order).toEqual(['one', 'two', 'handler'])
  })

  it('a before filter that calls ctx.json(...) short-circuits — handler does not run', async () => {
    const app = riftex()
    let handlerRan = false
    app.before('/guarded', (ctx) => {
      ctx.json({ blocked: true }, 403)
    })
    app.get('/guarded', () => {
      handlerRan = true
      return 'should not reach'
    })
    server = await app.listen(0, HOST)
    const res = await fetch(url(server, '/guarded'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ blocked: true })
    expect(handlerRan).toBe(false)
  })

  it('chain returns the app (app.before(...).before(...) is chainable)', () => {
    const app = riftex()
    const ret = app.before(async (_c, n) => {
      await n()
    })
    expect(ret).toBe(app)
    const ret2 = app.before('/x', async (_c, n) => {
      await n()
    })
    expect(ret2).toBe(app)
  })

  it('pattern boundary: /api matches /api and /api/users but NOT /apiary', async () => {
    const app = riftex()
    let hits = 0
    app.before('/api', async (_ctx, next) => {
      hits++
      await next()
    })
    app.get('/api', () => 'a')
    app.get('/api/users', () => 'au')
    app.get('/apiary', () => 'apy')
    server = await app.listen(0, HOST)
    await fetch(url(server, '/api'))
    await fetch(url(server, '/api/users'))
    await fetch(url(server, '/apiary'))
    expect(hits).toBe(2)
  })
})

describe('after(): pattern-scoped post-handler filter', () => {
  it('runs after the handler — observes the status the handler set', async () => {
    const app = riftex()
    let observedStatus: number | null = null
    app.after('/api/*', (ctx) => {
      observedStatus = (ctx as unknown as { _statusCode: number })._statusCode
    })
    app.get('/api/teapot', (ctx) => {
      ctx.json({ tea: true }, 418)
    })
    server = await app.listen(0, HOST)
    const res = await fetch(url(server, '/api/teapot'))
    expect(res.status).toBe(418)
    expect(observedStatus).toBe(418)
  })

  it('global after (no pattern) fires for every request', async () => {
    const app = riftex()
    let hits = 0
    app.after((_ctx) => {
      hits++
    })
    app.get('/a', () => 'a')
    app.get('/b', () => 'b')
    server = await app.listen(0, HOST)
    await fetch(url(server, '/a'))
    await fetch(url(server, '/b'))
    expect(hits).toBe(2)
  })

  it('after filter is scoped — does not fire for non-matching paths', async () => {
    const app = riftex()
    let hits = 0
    app.after('/api/*', (_ctx) => {
      hits++
    })
    app.get('/admin/users', () => 'a')
    server = await app.listen(0, HOST)
    await fetch(url(server, '/admin/users'))
    expect(hits).toBe(0)
  })

  it('an after filter that throws is caught by the error boundary', async () => {
    const app = riftex()
    app.onError((err, ctx) => {
      ctx.json({ caught: (err as Error).message }, 500)
    })
    app.after('/x', () => {
      throw new Error('after-boom')
    })
    app.get('/x', () => 'ok')
    server = await app.listen(0, HOST)
    const res = await fetch(url(server, '/x'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ caught: 'after-boom' })
  })

  it('after fires AFTER the handler completes (ordering test)', async () => {
    const app = riftex()
    const order: string[] = []
    app.after('/x', () => {
      order.push('after')
    })
    app.get('/x', () => {
      order.push('handler')
      return 'ok'
    })
    server = await app.listen(0, HOST)
    await fetch(url(server, '/x'))
    expect(order).toEqual(['handler', 'after'])
  })

  it('chain returns the app', () => {
    const app = riftex()
    const ret = app.after(() => {})
    expect(ret).toBe(app)
    const ret2 = app.after('/x', () => {})
    expect(ret2).toBe(app)
  })
})

describe('top-level before/after route to the default app', () => {
  it("topBefore + topGet + topListen — same default app", async () => {
    let gate = false
    topBefore('/admin/*', async (ctx, next) => {
      gate = true
      ctx.state.flag = 'admin'
      await next()
    })
    topGet('/admin/dash', (ctx) => ({ flag: ctx.state.flag ?? null }))
    server = await topListen(0, HOST)
    const res = await fetch(url(server, '/admin/dash'))
    expect(gate).toBe(true)
    expect(await res.json()).toEqual({ flag: 'admin' })
  })

  it("topAfter (no pattern) fires for every request", async () => {
    let hits = 0
    topAfter(() => {
      hits++
    })
    topGet('/a', () => 'a')
    topGet('/b', () => 'b')
    server = await topListen(0, HOST)
    await fetch(url(server, '/a'))
    await fetch(url(server, '/b'))
    expect(hits).toBe(2)
  })
})
