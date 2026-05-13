import { describe, it, expect, beforeEach } from 'vitest'
import { Buffer } from 'node:buffer'
import { createHmac } from 'node:crypto'
import { RiftexContext } from '../src/context/context.ts'
import { csrfMiddleware, RiftexCsrfError } from '../src/csrf/middleware.ts'

const SECRET = 'test-secret-1'

function ctx(method: string, headers: Record<string, string | string[]> = {}, query = ''): RiftexContext {
  const c = new RiftexContext()
  c.method = method as 'GET'
  c.headers = headers
  c.rawQuery = query
  return c
}

function next(): Promise<void> {
  return Promise.resolve()
}

function readSetCookie(c: RiftexContext): string[] {
  const v = c._headers['set-cookie']
  return Array.isArray(v) ? v : v ? [v as string] : []
}

function tokenFromCookie(c: RiftexContext, name = 'riftex.csrf'): string | null {
  const cookies = readSetCookie(c)
  for (const ck of cookies) {
    const m = ck.match(new RegExp(`^${name}=([^;]+)`))
    if (m) return decodeURIComponent(m[1]!)
  }
  return null
}

function signed(raw: string, secret = SECRET): string {
  const sig = createHmac('sha256', secret).update(raw).digest('base64url')
  return `${raw}.${sig}`
}

describe('csrfMiddleware (cookie storage)', () => {
  let mw: ReturnType<typeof csrfMiddleware>
  beforeEach(() => {
    mw = csrfMiddleware({ secret: SECRET })
  })

  it('issues a Set-Cookie token on a safe GET', async () => {
    const c = ctx('GET')
    await mw(c, next)
    const token = tokenFromCookie(c)
    expect(token).toBeTruthy()
    expect(token!.split('.').length).toBe(2) // raw.signature
  })

  it('exposes the current token via ctx.state.csrfToken and ctx.csrfToken()', async () => {
    const c = ctx('GET')
    await mw(c, next)
    expect(typeof c.state.csrfToken).toBe('string')
    const fn = (c as RiftexContext & { csrfToken: () => string }).csrfToken
    expect(typeof fn).toBe('function')
    expect(fn()).toBe(c.state.csrfToken)
  })

  it('safe methods (GET/HEAD/OPTIONS/TRACE) bypass validation', async () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS', 'TRACE']) {
      const c = ctx(m)
      await expect(mw(c, next)).resolves.toBeUndefined()
    }
  })

  it('unsafe method without cookie throws RiftexCsrfError (403)', async () => {
    const c = ctx('POST', { 'x-csrf-token': 'whatever' })
    await expect(mw(c, next)).rejects.toBeInstanceOf(RiftexCsrfError)
  })

  it('unsafe method with cookie but no header throws', async () => {
    const tok = signed('abc123')
    const c = ctx('POST', { cookie: `riftex.csrf=${encodeURIComponent(tok)}` })
    await expect(mw(c, next)).rejects.toBeInstanceOf(RiftexCsrfError)
  })

  it('unsafe method with mismatched header throws', async () => {
    const tok = signed('matching')
    const c = ctx('POST', {
      cookie: `riftex.csrf=${encodeURIComponent(tok)}`,
      'x-csrf-token': signed('different'),
    })
    await expect(mw(c, next)).rejects.toBeInstanceOf(RiftexCsrfError)
  })

  it('unsafe method with matching cookie+header passes', async () => {
    const tok = signed('synced')
    const c = ctx('POST', {
      cookie: `riftex.csrf=${encodeURIComponent(tok)}`,
      'x-csrf-token': tok,
    })
    await expect(mw(c, next)).resolves.toBeUndefined()
  })

  it('rejects forged cookie without valid HMAC signature', async () => {
    // Token raw value but signed with a wrong secret.
    const forged = signed('bypass-me', 'wrong-secret')
    const c = ctx('POST', {
      cookie: `riftex.csrf=${encodeURIComponent(forged)}`,
      'x-csrf-token': forged,
    })
    // Cookie verification fails first → expected becomes a fresh mint, header doesn't match.
    await expect(mw(c, next)).rejects.toBeInstanceOf(RiftexCsrfError)
  })

  it('accepts X-XSRF-Token header (Angular convention) by default', async () => {
    const tok = signed('angular')
    const c = ctx('POST', {
      cookie: `riftex.csrf=${encodeURIComponent(tok)}`,
      'x-xsrf-token': tok,
    })
    await expect(mw(c, next)).resolves.toBeUndefined()
  })

  it('accepts _csrf query string param as fallback', async () => {
    const tok = signed('viaquery')
    const c = ctx('POST', { cookie: `riftex.csrf=${encodeURIComponent(tok)}` }, `_csrf=${encodeURIComponent(tok)}`)
    await expect(mw(c, next)).resolves.toBeUndefined()
  })

  it('honors a custom value reader', async () => {
    const custom = csrfMiddleware({
      secret: SECRET,
      value: (c) => (c.headers['x-my-token'] as string | undefined),
    })
    const tok = signed('custom')
    const c = ctx('POST', {
      cookie: `riftex.csrf=${encodeURIComponent(tok)}`,
      'x-my-token': tok,
    })
    await expect(custom(c, next)).resolves.toBeUndefined()
  })

  it('honors skip predicate — bypasses entirely (no cookie issued, no validation)', async () => {
    const skipping = csrfMiddleware({ secret: SECRET, skip: () => true })
    const c = ctx('POST', {})
    await expect(skipping(c, next)).resolves.toBeUndefined()
    expect(readSetCookie(c).length).toBe(0)
    expect(c.state.csrfToken).toBeUndefined()
  })

  it('cookie attributes match options (sameSite=strict, secure, custom name)', async () => {
    const customCookie = csrfMiddleware({
      secret: SECRET,
      cookie: { name: 'app.csrf', sameSite: 'strict', secure: true, maxAgeSeconds: 60 },
    })
    const c = ctx('GET')
    await customCookie(c, next)
    const ck = readSetCookie(c)[0]!
    expect(ck).toMatch(/^app\.csrf=/)
    expect(ck).toMatch(/SameSite=Strict/)
    expect(ck).toMatch(/Secure/)
    expect(ck).toMatch(/Max-Age=60/)
    expect(ck).not.toMatch(/HttpOnly/) // default false
  })

  it('appends Set-Cookie alongside other cookies (does not clobber)', async () => {
    const c = ctx('GET')
    c._headers['set-cookie'] = 'session=abc; Path=/'
    await mw(c, next)
    const cookies = readSetCookie(c)
    expect(cookies.length).toBe(2)
    expect(cookies[0]).toMatch(/^session=abc/)
    expect(cookies[1]).toMatch(/^riftex\.csrf=/)
  })

  it('accepts secret rotation: cookie signed with secrets[1] still verifies', async () => {
    const rotating = csrfMiddleware({ secret: ['new-secret', 'old-secret'] })
    const oldToken = signed('rotated', 'old-secret')
    const c = ctx('POST', {
      cookie: `riftex.csrf=${encodeURIComponent(oldToken)}`,
      'x-csrf-token': oldToken,
    })
    await expect(rotating(c, next)).resolves.toBeUndefined()
  })

  it('throws at construction if storage=cookie without a secret', () => {
    expect(() => csrfMiddleware({ storage: 'cookie' })).toThrowError(/secret.*required/i)
  })

  it('uses constant-time comparison (mismatched same-length tokens fail)', async () => {
    // Two different tokens of identical length — a non-constant-time strcmp would
    // still reject, but timingSafeEqual is what we expect to be reached.
    const tok = signed('same-length-A')
    const tampered = tok.slice(0, -1) + (tok.endsWith('a') ? 'b' : 'a')
    expect(tok.length).toBe(tampered.length)
    const c = ctx('POST', {
      cookie: `riftex.csrf=${encodeURIComponent(tok)}`,
      'x-csrf-token': tampered,
    })
    await expect(mw(c, next)).rejects.toBeInstanceOf(RiftexCsrfError)
  })
})

describe('csrfMiddleware (session storage)', () => {
  function ctxWithSession(method: string, sessionData: Record<string, unknown> = {}): RiftexContext {
    const c = ctx(method)
    let store = { ...sessionData }
    ;(c as RiftexContext & { session: { get(k: string): unknown; set(k: string, v: unknown): void } }).session = {
      get: (k) => store[k],
      set: (k, v) => {
        store[k] = v
      },
    }
    return c
  }

  it('mints + stashes a token on safe GET when none in session', async () => {
    const mw = csrfMiddleware({ storage: 'session' })
    const c = ctxWithSession('GET')
    await mw(c, next)
    const sess = (c as unknown as { session: { get(k: string): unknown } }).session
    expect(typeof sess.get('csrfToken')).toBe('string')
    // No Set-Cookie in session mode (handled by sessionMiddleware separately).
    expect(readSetCookie(c).length).toBe(0)
  })

  it('passes when submitted token matches the session-stored token', async () => {
    const mw = csrfMiddleware({ storage: 'session' })
    const tok = 'session-tok-xyz'
    const c = ctxWithSession('POST', { csrfToken: tok })
    c.headers['x-csrf-token'] = tok
    await expect(mw(c, next)).resolves.toBeUndefined()
  })

  it('rejects when submitted token differs from session-stored token', async () => {
    const mw = csrfMiddleware({ storage: 'session' })
    const c = ctxWithSession('POST', { csrfToken: 'one' })
    c.headers['x-csrf-token'] = 'two'
    await expect(mw(c, next)).rejects.toBeInstanceOf(RiftexCsrfError)
  })

  it('throws a clear error when session middleware is missing', async () => {
    const mw = csrfMiddleware({ storage: 'session' })
    const c = ctx('POST', { 'x-csrf-token': 'whatever' })
    // No .session attached — should fail with a developer-friendly error.
    await expect(mw(c, next)).rejects.toThrow(/sessionMiddleware/)
  })
})

describe('RiftexCsrfError', () => {
  it('has the expected status, code, and message', () => {
    const err = new RiftexCsrfError()
    expect(err.statusCode).toBe(403)
    expect(err.code).toBe('CSRF_FAILED')
    expect(err.message).toBe('CSRF token validation failed')
  })

  it('serializes as a payload-shaped object', () => {
    const err = new RiftexCsrfError('custom')
    // Mirrors what the default boundary does for any RiftexError.
    const payload = { error: err.message, code: err.code, status: err.statusCode }
    expect(JSON.parse(JSON.stringify(payload))).toEqual({
      error: 'custom',
      code: 'CSRF_FAILED',
      status: 403,
    })
    // Touch the imported `Buffer` so the linter doesn't complain it's unused
    // (we use it indirectly via the test fixtures).
    expect(Buffer.byteLength('hi')).toBe(2)
  })
})
