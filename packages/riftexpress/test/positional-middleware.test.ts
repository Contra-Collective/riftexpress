import { describe, it, expect } from 'vitest'
import { riftex } from '../src/index.ts'
import { Router } from '../src/router/router.ts'
import { RiftexContext } from '../src/context/context.ts'
import type { RiftexMiddleware } from '../src/middleware/types.ts'

/**
 * Express-style positional middleware: `app.get(path, mw1, mw2, handler)`.
 * Inline middleware runs AFTER any global/scoped middleware and BEFORE the
 * route handler. Composition happens at registration / first-request time.
 */

function makeCtx(method = 'GET', path = '/'): RiftexContext {
  const ctx = new RiftexContext()
  ctx.method = method as RiftexContext['method']
  ctx.path = path
  ctx.url = path
  return ctx
}

describe('positional middleware — RiftexApp', () => {
  it('single inline middleware runs before the handler', async () => {
    const app = riftex()
    const order: string[] = []
    const mw1: RiftexMiddleware = async (_ctx, next) => {
      order.push('mw1')
      await next()
    }
    app.get('/', mw1, (ctx) => {
      order.push('handler')
      ctx.text('ok')
    })
    const ctx = makeCtx('GET', '/')
    await app.handle(ctx)
    expect(order).toEqual(['mw1', 'handler'])
    expect(ctx._statusCode).toBe(200)
  })

  it('multiple inline middleware run in declaration order', async () => {
    const app = riftex()
    const order: string[] = []
    const mk = (name: string): RiftexMiddleware => async (_ctx, next) => {
      order.push(name)
      await next()
    }
    app.get('/', mk('a'), mk('b'), mk('c'), (ctx) => {
      order.push('handler')
      ctx.text('ok')
    })
    await app.handle(makeCtx('GET', '/'))
    expect(order).toEqual(['a', 'b', 'c', 'handler'])
  })

  it('inline mw can short-circuit (no next() → handler does not run)', async () => {
    const app = riftex()
    let handlerRan = false
    const guard: RiftexMiddleware = (ctx) => {
      ctx.json({ blocked: true }, 403)
    }
    app.get('/', guard, () => {
      handlerRan = true
    })
    const ctx = makeCtx('GET', '/')
    await app.handle(ctx)
    expect(handlerRan).toBe(false)
    expect(ctx._statusCode).toBe(403)
  })

  it('order: global → inline → handler', async () => {
    const app = riftex()
    const order: string[] = []
    const mk = (name: string): RiftexMiddleware => async (_ctx, next) => {
      order.push(name)
      await next()
    }
    app.use(mk('global'))
    app.get('/', mk('inline'), (ctx) => {
      order.push('handler')
      ctx.text('ok')
    })
    await app.handle(makeCtx('GET', '/'))
    expect(order).toEqual(['global', 'inline', 'handler'])
  })

  it('order with mounted router: app.global → router.global → inline → handler', async () => {
    const app = riftex()
    const router = new Router()
    const order: string[] = []
    const mk = (name: string): RiftexMiddleware => async (_ctx, next) => {
      order.push(name)
      await next()
    }
    app.use(mk('app-global'))
    router.use(mk('router-global'))
    router.get('/x', mk('inline'), (ctx) => {
      order.push('handler')
      ctx.text('ok')
    })
    app.use('/api', router)
    await app.handle(makeCtx('GET', '/api/x'))
    expect(order).toEqual(['app-global', 'router-global', 'inline', 'handler'])
  })

  it('throwing inline mw flows to onError', async () => {
    const app = riftex()
    let seen: unknown = null
    app.onError((err, ctx) => {
      seen = err
      ctx.json({ caught: true }, 500)
    })
    const boom: RiftexMiddleware = () => {
      throw new Error('boom')
    }
    app.get('/', boom, (ctx) => ctx.text('never'))
    const ctx = makeCtx('GET', '/')
    await app.handle(ctx)
    expect((seen as Error).message).toBe('boom')
    expect(ctx._statusCode).toBe(500)
  })

  it('back-compat: single-arg (path, handler) still works', async () => {
    const app = riftex()
    app.get('/', (ctx) => ctx.text('hi'))
    const ctx = makeCtx('GET', '/')
    await app.handle(ctx)
    expect(ctx._statusCode).toBe(200)
    expect(ctx._body).toEqual({ kind: 'string', data: 'hi' })
  })

  it('all verbs support positional middleware', async () => {
    const verbs = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const
    for (const verb of verbs) {
      const app = riftex()
      const order: string[] = []
      const mw: RiftexMiddleware = async (_c, next) => {
        order.push('mw')
        await next()
      }
      app[verb]('/v', mw, (ctx) => {
        order.push('h')
        ctx.text('ok')
      })
      await app.handle(makeCtx(verb.toUpperCase(), '/v'))
      expect(order).toEqual(['mw', 'h'])
    }
  })
})

describe('positional middleware — Router', () => {
  it('Router.get accepts inline middleware', async () => {
    const app = riftex()
    const router = new Router()
    const order: string[] = []
    const mw: RiftexMiddleware = async (_c, next) => {
      order.push('mw')
      await next()
    }
    router.get('/', mw, (ctx) => {
      order.push('h')
      ctx.text('ok')
    })
    app.use('/r', router)
    await app.handle(makeCtx('GET', '/r'))
    expect(order).toEqual(['mw', 'h'])
  })

  it('Router throws if last positional arg is not a function', () => {
    const router = new Router()
    expect(() => {
      // @ts-expect-error — testing runtime guard
      router.get('/', 'not-a-function')
    }).toThrow(/handler/)
  })
})
