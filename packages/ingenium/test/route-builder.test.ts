import { describe, it, expect } from 'vitest'
import { IngeniumApp } from '../src/app.ts'
import { Router } from '../src/router/router.ts'

describe('app.route(path) — chainable verb builder', () => {
  it('stacks multiple verbs on the same path', async () => {
    const app = new IngeniumApp()
    app
      .route('/users/:id')
      .get((ctx) => { ctx.json({ verb: 'GET', id: ctx.params.id }) })
      .put((ctx) => { ctx.json({ verb: 'PUT', id: ctx.params.id }) })
      .delete((ctx) => { ctx.json({ verb: 'DELETE', id: ctx.params.id }) })

    const g = await app.inject({ method: 'GET', url: '/users/42' })
    expect(g.status).toBe(200)
    expect(g.json()).toEqual({ verb: 'GET', id: '42' })

    const p = await app.inject({ method: 'PUT', url: '/users/42' })
    expect(p.json()).toEqual({ verb: 'PUT', id: '42' })

    const d = await app.inject({ method: 'DELETE', url: '/users/42' })
    expect(d.json()).toEqual({ verb: 'DELETE', id: '42' })
  })

  it('returns the builder for chaining (not the app)', () => {
    const app = new IngeniumApp()
    const b1 = app.route('/x')
    const b2 = b1.get(() => 'a')
    expect(b2).toBe(b1)
  })

  it('accepts inline middleware before the handler', async () => {
    const app = new IngeniumApp()
    const trail: string[] = []
    const tag = (n: string) => async (_ctx: unknown, next: () => Promise<void>) => {
      trail.push(`>${n}`)
      await next()
      trail.push(`<${n}`)
    }
    app
      .route('/p')
      .get(tag('A'), tag('B'), (ctx) => { ctx.json({ ok: true }) })

    const res = await app.inject({ method: 'GET', url: '/p' })
    expect(res.status).toBe(200)
    expect(trail).toEqual(['>A', '>B', '<B', '<A'])
  })

  it('.all() registers GET, POST, PUT, PATCH, DELETE with the same handler', async () => {
    const app = new IngeniumApp()
    app.route('/any').all((ctx) => { ctx.text(ctx.method) })

    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await app.inject({ method: m, url: '/any' })
      expect(res.status).toBe(200)
      expect(res.body).toBe(m)
    }
  })

  it('unregistered method 405s with Allow header listing registered verbs', async () => {
    const app = new IngeniumApp()
    app
      .route('/u')
      .get(() => 'g')
      .post(() => 'p')

    const res = await app.inject({ method: 'DELETE', url: '/u' })
    expect(res.status).toBe(405)
    const allow = res.headers.allow
    expect(typeof allow === 'string' ? allow.split(', ').sort() : allow).toEqual(['GET', 'POST'])
  })

  it('scope.route() prefix-joins paths like the bare verbs do', async () => {
    const app = new IngeniumApp()
    app.scope('/api/v2', (scope) => {
      scope
        .route('/users/:id')
        .get((ctx) => { ctx.json({ id: ctx.params.id }) })
        .delete((ctx) => { ctx.status(204) })
    })

    const g = await app.inject({ method: 'GET', url: '/api/v2/users/42' })
    expect(g.status).toBe(200)
    expect(g.json()).toEqual({ id: '42' })

    const d = await app.inject({ method: 'DELETE', url: '/api/v2/users/42' })
    expect(d.status).toBe(204)

    // Out-of-scope path still 404s.
    const miss = await app.inject({ method: 'GET', url: '/users/42' })
    expect(miss.status).toBe(404)
  })

  it('Router.route() works the same way and mounts under a prefix', async () => {
    const app = new IngeniumApp()
    const api = new Router()
    api
      .route('/users/:id')
      .get((ctx) => { ctx.json({ id: ctx.params.id }) })
      .delete((ctx) => { ctx.status(204) })

    app.use('/api/v1', api)

    const g = await app.inject({ method: 'GET', url: '/api/v1/users/abc' })
    expect(g.status).toBe(200)
    expect(g.json()).toEqual({ id: 'abc' })

    const d = await app.inject({ method: 'DELETE', url: '/api/v1/users/abc' })
    expect(d.status).toBe(204)
  })
})
