import { describe, it, expect, vi } from 'vitest'
import { riftex } from '../src/index.ts'
import { RiftexContext } from '../src/context/context.ts'
import { RiftexHaltError } from '../src/errors.ts'

/**
 * Sinatra-style `ctx.halt(status, body?)`. Throws synchronously; the default
 * error boundary serializes per body shape.
 */

function makeCtx(method = 'GET', path = '/'): RiftexContext {
  const ctx = new RiftexContext()
  ctx.method = method as RiftexContext['method']
  ctx.path = path
  ctx.url = path
  return ctx
}

describe('ctx.halt — direct throw', () => {
  it('throws RiftexHaltError synchronously', () => {
    const ctx = new RiftexContext()
    expect(() => ctx.halt(401)).toThrow(RiftexHaltError)
  })

  it('halt with no body sets bodyShape="none"', () => {
    const ctx = new RiftexContext()
    try {
      ctx.halt(401)
    } catch (err) {
      const halt = err as RiftexHaltError
      expect(halt.statusCode).toBe(401)
      expect(halt.code).toBe('HALT')
      expect(halt.bodyShape).toBe('none')
      expect(halt.body).toBeUndefined()
    }
  })

  it('halt with string body sets bodyShape="text"', () => {
    const ctx = new RiftexContext()
    try {
      ctx.halt(404, 'Not Found')
    } catch (err) {
      const halt = err as RiftexHaltError
      expect(halt.statusCode).toBe(404)
      expect(halt.bodyShape).toBe('text')
      expect(halt.body).toBe('Not Found')
    }
  })

  it('halt with object body sets bodyShape="json"', () => {
    const ctx = new RiftexContext()
    try {
      ctx.halt(422, { error: 'Validation', fields: { x: 'bad' } })
    } catch (err) {
      const halt = err as RiftexHaltError
      expect(halt.statusCode).toBe(422)
      expect(halt.bodyShape).toBe('json')
      expect(halt.body).toEqual({ error: 'Validation', fields: { x: 'bad' } })
    }
  })

  it('synchronous: code after halt does not execute', () => {
    const after = vi.fn()
    const ctx = new RiftexContext()
    try {
      ctx.halt(401)
      after()
    } catch {
      /* swallow */
    }
    expect(after).not.toHaveBeenCalled()
  })

  it('TypeScript: halt return type is `never` — call site is unreachable', () => {
    const ctx = new RiftexContext()
    // The `never` return type makes any code AFTER `ctx.halt(...)` provably
    // unreachable — verified by the lines below being parseable in a function
    // whose declared return type is `never` (only reachable via throw).
    const fn: () => never = () => ctx.halt(401, 'denied')
    expect(typeof fn).toBe('function')
    // Also: a non-`never` function can use it as a guard (control flow narrows).
    const guard = (maybe: string | undefined): string => {
      if (maybe === undefined) ctx.halt(400, 'missing')
      // `maybe` is narrowed to `string` here because halt returns `never`.
      return (maybe as string).toUpperCase()
    }
    expect(typeof guard).toBe('function')
  })
})

describe('ctx.halt — error boundary serialization', () => {
  it('halt(401) → 401 with default JSON {error, code: HALT}', async () => {
    const app = riftex()
    app.get('/', (ctx) => ctx.halt(401))
    const ctx = makeCtx('GET', '/')
    await app.handle(ctx)
    expect(ctx._statusCode).toBe(401)
    const body = ctx._body
    expect(body.kind).toBe('string')
    if (body.kind === 'string') {
      const parsed = JSON.parse(body.data) as Record<string, unknown>
      expect(parsed.code).toBe('HALT')
      expect(typeof parsed.error).toBe('string')
    }
    expect(ctx._headers['content-type']).toMatch(/application\/json/)
  })

  it('halt(404, "Not Found") → 404 text/plain body verbatim', async () => {
    const app = riftex()
    app.get('/', (ctx) => ctx.halt(404, 'Not Found'))
    const ctx = makeCtx('GET', '/')
    await app.handle(ctx)
    expect(ctx._statusCode).toBe(404)
    expect(ctx._body).toEqual({ kind: 'string', data: 'Not Found' })
    expect(ctx._headers['content-type']).toMatch(/text\/plain/)
  })

  it('halt(422, {...}) → 422 JSON body matches', async () => {
    const app = riftex()
    app.get('/', (ctx) => ctx.halt(422, { error: 'Validation', fields: { x: 'bad' } }))
    const ctx = makeCtx('GET', '/')
    await app.handle(ctx)
    expect(ctx._statusCode).toBe(422)
    expect(ctx._headers['content-type']).toMatch(/application\/json/)
    if (ctx._body.kind === 'string') {
      const parsed = JSON.parse(ctx._body.data) as Record<string, unknown>
      expect(parsed).toEqual({ error: 'Validation', fields: { x: 'bad' } })
    } else {
      throw new Error('expected string body')
    }
  })

  it('app.onError can intercept RiftexHaltError and override', async () => {
    const app = riftex()
    let seenStatus: number | null = null
    app.onError((err, ctx) => {
      if (err instanceof RiftexHaltError) {
        seenStatus = err.statusCode
        ctx.set('x-halted', 'yes')
        ctx.json({ overridden: true }, err.statusCode)
        return
      }
      throw err
    })
    app.get('/', (ctx) => ctx.halt(401, 'nope'))
    const ctx = makeCtx('GET', '/')
    await app.handle(ctx)
    expect(seenStatus).toBe(401)
    expect(ctx._headers['x-halted']).toBe('yes')
    if (ctx._body.kind === 'string') {
      expect(JSON.parse(ctx._body.data)).toEqual({ overridden: true })
    }
  })

  it('halt from inline middleware also serializes correctly', async () => {
    const app = riftex()
    let handlerRan = false
    app.get(
      '/',
      (ctx, _next) => {
        ctx.halt(403, 'forbidden')
      },
      (_ctx) => {
        handlerRan = true
      },
    )
    const ctx = makeCtx('GET', '/')
    await app.handle(ctx)
    expect(handlerRan).toBe(false)
    expect(ctx._statusCode).toBe(403)
    expect(ctx._body).toEqual({ kind: 'string', data: 'forbidden' })
  })
})
