import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { RiftexError } from '../errors.ts'
import type { RiftexMiddleware } from '../middleware/types.ts'
import type { RiftexContext } from '../context/context.ts'
import type { CsrfCookieOptions, CsrfOptions, CsrfValueReader } from './types.ts'

/** 403 Forbidden — CSRF token missing or mismatched. */
export class RiftexCsrfError extends RiftexError {
  constructor(message = 'CSRF token validation failed') {
    super(403, 'CSRF_FAILED', message)
  }
}

const TOKEN_BYTES = 18
const SAFE_METHODS_DEFAULT: readonly string[] = ['GET', 'HEAD', 'OPTIONS', 'TRACE']
const COOKIE_NAME_DEFAULT = 'riftex.csrf'
const HEADER_NAMES_DEFAULT: readonly string[] = ['x-csrf-token', 'x-xsrf-token']

interface ResolvedOptions {
  secrets: string[]                   // first signs, all verify (rotation)
  storage: 'cookie' | 'session'
  cookie: Required<CsrfCookieOptions>
  ignoreMethods: Set<string>
  value: CsrfValueReader
  skip: ((ctx: RiftexContext) => boolean | Promise<boolean>) | null
}

/**
 * CSRF protection middleware. Two modes:
 *
 * - `storage: 'cookie'` (default) — double-submit cookie pattern. A
 *   randomly-generated token is HMAC-signed, written to a non-HttpOnly
 *   cookie on safe requests, and the client must echo the cookie value
 *   back in a header (`X-CSRF-Token`) on unsafe requests. The signature
 *   prevents client-side forgery; the same-origin policy prevents
 *   cross-origin sites from reading the cookie.
 *
 * - `storage: 'session'` — synchronizer pattern. The token is stored on
 *   `ctx.session` and matched against the submitted token. Requires
 *   `sessionMiddleware` to run before this middleware.
 *
 * Use `ctx.state.csrfToken` (or call `(ctx as RiftexContext & { csrfToken(): string }).csrfToken()`)
 * to read the current token to embed in HTML forms or send to a JS client.
 */
export function csrfMiddleware(opts: CsrfOptions = {}): RiftexMiddleware {
  const resolved = resolveOptions(opts)
  if (resolved.storage === 'cookie' && resolved.secrets.length === 0) {
    throw new Error("csrfMiddleware: `secret` is required when storage is 'cookie'")
  }

  return async (ctx, next) => {
    if (resolved.skip && (await resolved.skip(ctx))) {
      await next()
      return
    }

    // Resolve / mint the expected token for this request.
    let expected = readExpectedToken(ctx, resolved)
    let mintedThisRequest = false
    if (!expected) {
      expected = mintToken(resolved)
      mintedThisRequest = true
    }

    // Expose token to handlers via ctx.state.csrfToken AND a method.
    ctx.state.csrfToken = expected
    ;(ctx as RiftexContext & { csrfToken: () => string }).csrfToken = () => expected as string

    const isUnsafe = !resolved.ignoreMethods.has(ctx.method)
    if (isUnsafe) {
      const submitted = await resolved.value(ctx)
      if (!submitted || !tokenMatches(submitted, expected)) {
        throw new RiftexCsrfError()
      }
    }

    await next()

    // Issue (or refresh) the cookie on cookie-storage mode.
    if (resolved.storage === 'cookie' && (mintedThisRequest || isUnsafe)) {
      writeCookie(ctx, expected, resolved.cookie)
    } else if (resolved.storage === 'session' && mintedThisRequest) {
      writeSession(ctx, expected)
    }
  }
}

// ───── Token mint / verify ─────────────────────────────────────────────────

function mintToken(opts: ResolvedOptions): string {
  const raw = randomBytes(TOKEN_BYTES).toString('base64url')
  if (opts.storage === 'session' || opts.secrets.length === 0) return raw
  // Signed for double-submit so a forged cookie value can't pass verification.
  const sig = signToken(raw, opts.secrets[0]!)
  return `${raw}.${sig}`
}

function signToken(raw: string, secret: string): string {
  return createHmac('sha256', secret).update(raw).digest('base64url')
}

function tokenMatches(submitted: string, expected: string): boolean {
  const a = Buffer.from(submitted)
  const b = Buffer.from(expected)
  // Length-mismatch already rules out a match; timingSafeEqual requires equal length.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function verifySignedToken(token: string, secrets: readonly string[]): boolean {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return false
  const raw = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  for (const secret of secrets) {
    const expected = signToken(raw, secret)
    if (expected.length !== sig.length) continue
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return true
  }
  return false
}

// ───── Storage ─────────────────────────────────────────────────────────────

function readExpectedToken(ctx: RiftexContext, opts: ResolvedOptions): string | null {
  if (opts.storage === 'cookie') {
    const cookies = parseCookies(ctx.headers['cookie'])
    const token = cookies[opts.cookie.name]
    if (!token) return null
    if (opts.secrets.length > 0 && !verifySignedToken(token, opts.secrets)) return null
    return token
  }
  // Session storage
  const session = (ctx as RiftexContext & { session?: { get: (k: string) => unknown } }).session
  if (!session) {
    throw new Error("csrfMiddleware: storage='session' requires sessionMiddleware to run first")
  }
  const token = session.get('csrfToken')
  return typeof token === 'string' && token.length > 0 ? token : null
}

function writeCookie(ctx: RiftexContext, token: string, cookie: Required<CsrfCookieOptions>): void {
  const parts: string[] = [`${cookie.name}=${encodeURIComponent(token)}`]
  parts.push(`Path=${cookie.path}`)
  if (cookie.domain) parts.push(`Domain=${cookie.domain}`)
  parts.push(`Max-Age=${cookie.maxAgeSeconds}`)
  parts.push(`SameSite=${cookie.sameSite[0]!.toUpperCase() + cookie.sameSite.slice(1)}`)
  if (cookie.secure) parts.push('Secure')
  if (cookie.httpOnly) parts.push('HttpOnly')
  appendSetCookie(ctx, parts.join('; '))
}

function writeSession(ctx: RiftexContext, token: string): void {
  const session = (ctx as RiftexContext & { session?: { set: (k: string, v: unknown) => void } }).session
  if (!session) return
  session.set('csrfToken', token)
}

function appendSetCookie(ctx: RiftexContext, value: string): void {
  const existing = ctx._headers['set-cookie']
  if (!existing) {
    ctx._headers['set-cookie'] = [value]
  } else if (Array.isArray(existing)) {
    existing.push(value)
  } else {
    ctx._headers['set-cookie'] = [existing, value]
  }
}

function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  const flat = Array.isArray(header) ? header.join('; ') : header
  for (const piece of flat.split(';')) {
    const eq = piece.indexOf('=')
    if (eq < 0) continue
    const k = piece.slice(0, eq).trim()
    const v = piece.slice(eq + 1).trim()
    if (!k || k in out) continue // first occurrence wins
    try {
      out[k] = decodeURIComponent(v)
    } catch {
      out[k] = v
    }
  }
  return out
}

// ───── Options resolution ──────────────────────────────────────────────────

function resolveOptions(opts: CsrfOptions): ResolvedOptions {
  const secrets =
    typeof opts.secret === 'string'
      ? [opts.secret]
      : Array.isArray(opts.secret)
        ? [...opts.secret]
        : []
  const storage = opts.storage ?? 'cookie'
  const cookie: Required<CsrfCookieOptions> = {
    name: opts.cookie?.name ?? COOKIE_NAME_DEFAULT,
    path: opts.cookie?.path ?? '/',
    domain: opts.cookie?.domain ?? '',
    sameSite: opts.cookie?.sameSite ?? 'lax',
    secure: opts.cookie?.secure ?? false,
    httpOnly: opts.cookie?.httpOnly ?? false,
    maxAgeSeconds: opts.cookie?.maxAgeSeconds ?? 7 * 24 * 60 * 60,
  }
  const ignoreMethods = new Set((opts.ignoreMethods ?? SAFE_METHODS_DEFAULT).map((m) => m.toUpperCase()))
  const value = opts.value ?? defaultValueReader
  return { secrets, storage, cookie, ignoreMethods, value, skip: opts.skip ?? null }
}

const defaultValueReader: CsrfValueReader = (ctx) => {
  for (const name of HEADER_NAMES_DEFAULT) {
    const v = ctx.headers[name]
    if (v) return Array.isArray(v) ? v[0] : v
  }
  const q = ctx.query.get('_csrf')
  return q ?? undefined
}
