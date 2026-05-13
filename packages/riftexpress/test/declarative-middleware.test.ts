import { describe, it, expect } from 'vitest'
import { riftex } from '../src/index.ts'
import { RiftexContext } from '../src/context/context.ts'
import type { RiftexMiddleware } from '../src/middleware/types.ts'

/**
 * `app.declare(name, factory)` registers a name → middleware-factory
 * mapping. Routes can then opt in via a leading options object:
 *   `app.get('/admin', { auth: ['admin'] }, handler)`
 * Translation happens at REGISTRATION time, not request time, so the
 * per-request hot path has zero declarative-middleware overhead.
 */

function makeCtx(method = 'GET', path = '/'): RiftexContext {
  const ctx = new RiftexContext()
  ctx.method = method as RiftexContext['method']
  ctx.path = path
  ctx.url = path
  return ctx
}

describe('app.declare() — basic', () => {
  it('declared middleware runs before handler', async () => {
    const app = riftex()
    const order: string[] = []
    app.declare<string[]>('auth', (roles) => async (ctx, next) => {
      order.push(`auth:${roles.join(',')}`)
      ctx.state.roles = roles
      await next()
    })
    app.get('/', { auth: ['admin'] }, (ctx) => {
      order.push('handler')
      ctx.json({ roles: ctx.state.roles })
    })
    const ctx = makeCtx('GET', '/')
    await app.handle(ctx)
    expect(order).toEqual(['auth:admin', 'handler'])
    expect(ctx._statusCode).toBe(200)
  })

  it('multiple declarators run in object-key insertion order', async () => {
    const app = riftex()
    const order: string[] = []
    const mk = (name: string) => async (_ctx: RiftexContext, next: () => Promise<void>) => {
      order.push(name)
      await next()
    }
    app.declare<string[]>('auth', (roles) => mk(`auth:${roles.join(',')}`))
    app.declare<string>('rateLimit', (spec) => mk(`rl:${spec}`))
    app.get('/', { auth: ['admin'], rateLimit: '10/min' }, (ctx) => {
      order.push('handler')
      ctx.text('ok')
    })
    await app.handle(makeCtx('GET', '/'))
    expect(order).toEqual(['auth:admin', 'rl:10/min', 'handler'])
  })

  it('declarative + positional: declarative first, then positional, then handler', async () => {
    const app = riftex()
    const order: string[] = []
    const mk = (name: string): RiftexMiddleware => async (_c, next) => {
      order.push(name)
      await next()
    }
    app.declare<string[]>('auth', (roles) => mk(`auth:${roles.join(',')}`))
    app.get('/', { auth: ['x'] }, mk('inline-1'), mk('inline-2'), (ctx) => {
      order.push('handler')
      ctx.text('ok')
    })
    await app.handle(makeCtx('GET', '/'))
    expect(order).toEqual(['auth:x', 'inline-1', 'inline-2', 'handler'])
  })

  it('unknown declarator throws at REGISTRATION time (not request time)', () => {
    const app = riftex()
    expect(() => {
      app.get('/', { auth: ['x'] }, (ctx) => ctx.text('ok'))
    }).toThrow(/unknown declarator 'auth'/)
  })

  it('declarator can be overridden by a second app.declare call', async () => {
    const app = riftex()
    const order: string[] = []
    app.declare<string>('auth', () => async (_c, next) => {
      order.push('v1')
      await next()
    })
    app.declare<string>('auth', () => async (_c, next) => {
      order.push('v2')
      await next()
    })
    app.get('/', { auth: 'whatever' }, (ctx) => ctx.text('ok'))
    await app.handle(makeCtx('GET', '/'))
    expect(order).toEqual(['v2'])
  })

  it('app.declare is chainable', () => {
    const app = riftex()
    const result = app
      .declare<string>('a', () => async (_c, next) => next())
      .declare<string>('b', () => async (_c, next) => next())
    expect(result).toBe(app)
  })

  it('back-compat: (path, handler) without options still works', async () => {
    const app = riftex()
    app.get('/', (ctx) => ctx.text('ok'))
    const ctx = makeCtx('GET', '/')
    await app.handle(ctx)
    expect(ctx._statusCode).toBe(200)
  })

  it('back-compat: (path, mw, handler) without options still works', async () => {
    const app = riftex()
    const order: string[] = []
    const mw: RiftexMiddleware = async (_c, next) => {
      order.push('mw')
      await next()
    }
    app.get('/', mw, (ctx) => {
      order.push('h')
      ctx.text('ok')
    })
    await app.handle(makeCtx('GET', '/'))
    expect(order).toEqual(['mw', 'h'])
  })

  it('register-time lookup: declarator must exist BEFORE the route is registered', () => {
    const app = riftex()
    // Register the route BEFORE declaring 'auth' — must throw eagerly.
    expect(() => {
      app.get('/late', { auth: ['x'] }, (ctx) => ctx.text('ok'))
    }).toThrow(/unknown declarator 'auth'/)
    // Declaring it AFTER does not retroactively fix anything (the throw
    // already happened); confirm the registry can still accept declarators.
    app.declare<string[]>('auth', () => async (_c, next) => next())
    app.get('/ok', { auth: ['x'] }, (ctx) => ctx.text('ok'))
  })
})

describe('app.declare() — plain-options-object detection', () => {
  it('a function in arg-position 0 is treated as middleware, not options', async () => {
    const app = riftex()
    const order: string[] = []
    const mw: RiftexMiddleware = async (_c, next) => {
      order.push('mw')
      await next()
    }
    app.get('/', mw, (ctx) => {
      order.push('h')
      ctx.text('ok')
    })
    await app.handle(makeCtx('GET', '/'))
    expect(order).toEqual(['mw', 'h'])
  })

  it('a class instance in arg-position 0 is NOT treated as options', () => {
    const app = riftex()
    class NotAnOptionsBag {
      foo = 'bar'
    }
    const instance = new NotAnOptionsBag()
    // The class instance has a non-Object prototype, so isPlainOptionsObject
    // rejects it. Without `auth` declarator, this should NOT throw "unknown
    // declarator" — instead it should fail because the value isn't a function
    // (it ends up in the inline-mw position and Router rejects it).
    expect(() => {
      // @ts-expect-error — instance is not assignable to the public overloads
      app.get('/', instance, (ctx) => ctx.text('ok'))
    }).toThrow(/middleware|function/i)
  })

  it('an Array in arg-position 0 is NOT treated as options', () => {
    const app = riftex()
    expect(() => {
      // @ts-expect-error — array is not in the public overload union
      app.get('/', [1, 2, 3], (ctx) => ctx.text('ok'))
    }).toThrow(/middleware|function/i)
  })
})
