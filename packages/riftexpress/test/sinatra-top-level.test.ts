/**
 * Sinatra-style top-level shorthand — `get`/`post`/`use`/`listen`/...
 * route through a lazy singleton `RiftexApp`.
 *
 * Each test calls `_resetDefaultApp()` first so the singleton is fresh.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  defaultApp,
  _resetDefaultApp,
  get,
  post,
  put,
  patch,
  del,
  head,
  options,
  use,
  onError,
  listen,
} from '../src/sinatra/top-level.ts'
import type { ListeningServer } from '../src/transport/types.ts'
import type { RiftexContext } from '../src/context/context.ts'

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

describe('sinatra top-level: defaultApp()', () => {
  it('creates a RiftexApp on first call', () => {
    const a = defaultApp()
    expect(a).toBeDefined()
    expect(typeof a.get).toBe('function')
  })

  it('returns the same instance on subsequent calls', () => {
    const a = defaultApp()
    const b = defaultApp()
    expect(a).toBe(b)
  })

  it('every verb function returns the default app (chainable)', () => {
    const a = defaultApp()
    expect(get('/g', () => 'g')).toBe(a)
    expect(post('/p', () => 'p')).toBe(a)
    expect(put('/u', () => 'u')).toBe(a)
    expect(patch('/h', () => 'h')).toBe(a)
    expect(del('/d', () => 'd')).toBe(a)
    expect(head('/x', () => 'x')).toBe(a)
    expect(options('/o', () => 'o')).toBe(a)
  })
})

describe('sinatra top-level: GET via real HTTP', () => {
  it("get('/', () => 'hi') returns 200 hi", async () => {
    get('/', () => 'hi')
    server = await listen(0, HOST)
    const res = await fetch(url(server, '/'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hi')
  })

  it('typed params: get(:id) reads ctx.params.id', async () => {
    get('/users/:id', (ctx: RiftexContext) => ({ id: ctx.params.id }))
    server = await listen(0, HOST)
    const res = await fetch(url(server, '/users/42'))
    expect(await res.json()).toEqual({ id: '42' })
  })
})

describe('sinatra top-level: all seven verbs route to the default app', () => {
  it('POST works', async () => {
    post('/x', () => ({ verb: 'POST' }))
    server = await listen(0, HOST)
    const res = await fetch(url(server, '/x'), { method: 'POST' })
    expect(await res.json()).toEqual({ verb: 'POST' })
  })

  it('PUT works', async () => {
    put('/x', () => ({ verb: 'PUT' }))
    server = await listen(0, HOST)
    const res = await fetch(url(server, '/x'), { method: 'PUT' })
    expect(await res.json()).toEqual({ verb: 'PUT' })
  })

  it('PATCH works', async () => {
    patch('/x', () => ({ verb: 'PATCH' }))
    server = await listen(0, HOST)
    const res = await fetch(url(server, '/x'), { method: 'PATCH' })
    expect(await res.json()).toEqual({ verb: 'PATCH' })
  })

  it('DELETE (exported as `del`) works', async () => {
    del('/x', () => ({ verb: 'DELETE' }))
    server = await listen(0, HOST)
    const res = await fetch(url(server, '/x'), { method: 'DELETE' })
    expect(await res.json()).toEqual({ verb: 'DELETE' })
  })

  it('HEAD works', async () => {
    head('/x', (ctx) => {
      ctx.status(204).set('x-head', 'ok')
    })
    server = await listen(0, HOST)
    const res = await fetch(url(server, '/x'), { method: 'HEAD' })
    expect(res.status).toBe(204)
    expect(res.headers.get('x-head')).toBe('ok')
  })

  it('OPTIONS works', async () => {
    options('/x', () => 'opts')
    server = await listen(0, HOST)
    const res = await fetch(url(server, '/x'), { method: 'OPTIONS' })
    expect(await res.text()).toBe('opts')
  })
})

describe('sinatra top-level: use(...)', () => {
  it('use(mw) adds a global middleware that runs for every request', async () => {
    let hits = 0
    use(async (_ctx, next) => {
      hits++
      await next()
    })
    get('/a', () => 'a')
    get('/b', () => 'b')
    server = await listen(0, HOST)
    await fetch(url(server, '/a'))
    await fetch(url(server, '/b'))
    expect(hits).toBe(2)
  })

  it("use('/api', mw) mounts middleware at a prefix", async () => {
    let apiHits = 0
    use('/api', async (_ctx, next) => {
      apiHits++
      await next()
    })
    get('/api/v', () => 'v')
    get('/other', () => 'o')
    server = await listen(0, HOST)
    await fetch(url(server, '/api/v'))
    await fetch(url(server, '/other'))
    expect(apiHits).toBe(1)
  })
})

describe('sinatra top-level: onError(...)', () => {
  it('catches errors thrown by route handlers', async () => {
    onError((err, ctx) => {
      ctx.json({ err: (err as Error).message }, 500)
    })
    get('/boom', () => {
      throw new Error('kaboom')
    })
    server = await listen(0, HOST)
    const res = await fetch(url(server, '/boom'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ err: 'kaboom' })
  })
})

describe('sinatra top-level: listen(...)', () => {
  it('returns a ListeningServer with a port', async () => {
    get('/', () => 'ok')
    server = await listen(0, HOST)
    expect(typeof server.port).toBe('number')
    expect(server.port).toBeGreaterThan(0)
  })

  it('server.close() shuts the server down', async () => {
    get('/', () => 'ok')
    server = await listen(0, HOST)
    const port = server.port
    await server.close()
    server = null
    // Best-effort: a second close should not throw, and a request should fail.
    await expect(fetch(`http://${HOST}:${port}/`)).rejects.toBeDefined()
  })
})

describe('sinatra top-level: _resetDefaultApp()', () => {
  it('between tests gives a clean slate (prior routes are gone)', async () => {
    get('/round-one', () => 'one')
    _resetDefaultApp()
    // The fresh app has no /round-one route.
    get('/round-two', () => 'two')
    server = await listen(0, HOST)
    const r1 = await fetch(url(server, '/round-one'))
    expect(r1.status).toBe(404)
    const r2 = await fetch(url(server, '/round-two'))
    expect(await r2.text()).toBe('two')
  })

  it('throws when NODE_ENV === production', () => {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      expect(() => _resetDefaultApp()).toThrow(/test-only/)
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = prev
    }
  })

  it('does not throw under NODE_ENV=test or development', () => {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'test'
    try {
      expect(() => _resetDefaultApp()).not.toThrow()
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = prev
    }
  })
})

describe('sinatra top-level: re-exports from the package root', () => {
  it("import { get } from 'riftexpress' exists and routes to defaultApp", async () => {
    const root = await import('../src/index.ts')
    expect(typeof root.get).toBe('function')
    expect(typeof root.listen).toBe('function')
    expect(typeof root.delete).toBe('function')
    // Tied to the same default app:
    root.get('/root-import', () => 'r')
    server = await listen(0, HOST)
    const res = await fetch(url(server, '/root-import'))
    expect(await res.text()).toBe('r')
  })
})

// Silence the unused-import check in environments that strip vi.
void vi
