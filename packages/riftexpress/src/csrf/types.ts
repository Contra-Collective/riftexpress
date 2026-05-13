import type { RiftexContext } from '../context/context.ts'

/**
 * Where the CSRF token lives between requests.
 *
 * - `'cookie'` (default): double-submit cookie pattern. Token is generated
 *   on safe requests, written to a non-HttpOnly cookie, and the client must
 *   echo it back via a header on unsafe requests. No session required.
 * - `'session'`: synchronizer pattern. Token is stored on `ctx.session`
 *   and validated against the submitted token on unsafe requests. Requires
 *   `sessionMiddleware` to run before this middleware.
 */
export type CsrfStorage = 'cookie' | 'session'

/** How to extract the submitted token from an incoming request. */
export type CsrfValueReader = (ctx: RiftexContext) => string | undefined | Promise<string | undefined>

export interface CsrfCookieOptions {
  /** Cookie name. Default `riftex.csrf`. */
  name?: string
  /** Restrict cookie to a single subpath. Default `/`. */
  path?: string
  /** Restrict cookie to a domain. Default unset. */
  domain?: string
  /** SameSite policy. Default `'lax'`. */
  sameSite?: 'lax' | 'strict' | 'none'
  /** Mark cookie Secure. Default `false`; set `true` behind TLS. */
  secure?: boolean
  /**
   * Mark cookie HttpOnly. **Default `false`** — clients must read the cookie
   * to copy the value into the request header. Setting `true` would break the
   * double-submit pattern; only enable with a custom value reader that pulls
   * the token from elsewhere.
   */
  httpOnly?: boolean
  /** Cookie max-age (seconds). Default 7 days. */
  maxAgeSeconds?: number
}

export interface CsrfOptions {
  /**
   * HMAC secret used to sign the token. Required for the cookie storage
   * mode (signed double-submit). For session storage the secret is optional
   * — the session id already authenticates the binding.
   */
  secret?: string | string[]
  /** Token storage strategy. Default `'cookie'`. */
  storage?: CsrfStorage
  /** Cookie options when `storage === 'cookie'`. */
  cookie?: CsrfCookieOptions
  /** Methods that bypass validation. Default `['GET', 'HEAD', 'OPTIONS', 'TRACE']`. */
  ignoreMethods?: readonly string[]
  /**
   * How to extract the submitted token. Default reads (in order):
   *   1. `X-CSRF-Token` header
   *   2. `X-XSRF-Token` header (Angular convention)
   *   3. `_csrf` query string parameter
   */
  value?: CsrfValueReader
  /**
   * Per-request opt-out. Return `true` to skip validation entirely for
   * this request (and skip token issuance).
   */
  skip?: (ctx: RiftexContext) => boolean | Promise<boolean>
}
