# `riftex.csrf` — CSRF protection

Source: [`packages/riftexpress/src/csrf/middleware.ts`](../../packages/riftexpress/src/csrf/middleware.ts), [`csrf/types.ts`](../../packages/riftexpress/src/csrf/types.ts).

```ts
import { riftex, csrfMiddleware, RiftexCsrfError } from 'riftexpress'
import type { CsrfOptions, CsrfStorage, CsrfCookieOptions, CsrfValueReader } from 'riftexpress'
```

`riftex.csrf(opts)` is an alias for `csrfMiddleware(opts)`.

---

## Storage modes

### `'cookie'` (default)

Double-submit cookie pattern with HMAC signing.

1. On a safe request (`GET`/`HEAD`/`OPTIONS`/`TRACE`), the middleware ensures a token cookie exists. If absent, it mints `randomBytes(18)` (base64url) + an HMAC-SHA-256 signature, joined as `<raw>.<sig>`, and writes it as `Set-Cookie: riftex.csrf=...`.
2. On an unsafe request (`POST`/`PUT`/`PATCH`/`DELETE`/...), it:
   - Reads the cookie value, verifies the HMAC signature against `secret` (or any value in the rotation array)
   - Reads the submitted token from the configured value reader (default: `X-CSRF-Token` header → `X-XSRF-Token` header → `?_csrf=` query param)
   - Compares the two with `crypto.timingSafeEqual`
   - Throws `RiftexCsrfError` (HTTP 403, code `CSRF_FAILED`) on any mismatch

`secret` is **required** in this mode. Without it the middleware throws at construction.

### `'session'`

Synchronizer pattern. The token is stored on `ctx.session.csrfToken`. Requires `sessionMiddleware` to run before the CSRF middleware. The signature step is skipped — the session id already authenticates the binding.

If `ctx.session` isn't present when validation runs, you get a clear `Error("csrfMiddleware: storage='session' requires sessionMiddleware to run first")` rather than a silent failure.

---

## Options

```ts
interface CsrfOptions {
  secret?: string | string[]              // required for 'cookie'; first signs, all verify
  storage?: 'cookie' | 'session'          // default 'cookie'
  cookie?: CsrfCookieOptions
  ignoreMethods?: readonly string[]       // default ['GET','HEAD','OPTIONS','TRACE']
  value?: (ctx) => string | undefined | Promise<string | undefined>
  skip?: (ctx) => boolean | Promise<boolean>
}

interface CsrfCookieOptions {
  name?: string             // default 'riftex.csrf'
  path?: string             // default '/'
  domain?: string
  sameSite?: 'lax' | 'strict' | 'none'   // default 'lax'
  secure?: boolean          // default false; set true behind TLS
  httpOnly?: boolean        // default false — must be readable by client JS
  maxAgeSeconds?: number    // default 7 days
}
```

`httpOnly: false` is the default and intentional. The double-submit pattern requires the client to copy the cookie value into a request header, so the cookie must be readable from JS. Setting `httpOnly: true` only makes sense if you also pass a custom `value` reader that pulls the token from somewhere else (e.g. a meta tag rendered server-side).

---

## Reading the current token

Inside a handler, the active token is exposed two ways:

```ts
app.get('/form', (ctx) => {
  const token = (ctx as RiftexContext & { csrfToken: () => string }).csrfToken()
  // or: const token = ctx.state.csrfToken as string
  return `<form method="POST" action="/submit">
    <input type="hidden" name="_csrf" value="${token}">
    <button>Submit</button>
  </form>`
})
```

For typed access without the cast, augment `RiftexContext` in your project:

```ts
declare module 'riftexpress' {
  interface RiftexContext {
    csrfToken(): string
  }
}
```

---

## Failure mode

```ts
class RiftexCsrfError extends RiftexError {
  statusCode = 403
  code = 'CSRF_FAILED'
}
```

The default error boundary serializes it as `{ error: 'CSRF token validation failed', code: 'CSRF_FAILED' }` with a 403 status. Customize via `app.onError`:

```ts
app.onError((err, ctx) => {
  if (err instanceof RiftexCsrfError) {
    return ctx.json({ error: 'Refresh and try again', code: err.code }, 403)
  }
  throw err
})
```

---

## Skip cases

Common opt-outs:

```ts
app.use(riftex.csrf({
  secret: process.env.CSRF_SECRET!,
  skip: (ctx) =>
    ctx.path.startsWith('/api/webhooks/') ||  // signed by sender, not a browser
    ctx.headers['authorization']?.startsWith('Bearer '), // pure-API call with bearer auth
}))
```

`skip: () => true` short-circuits entirely — no cookie issued, no validation, no `ctx.csrfToken()`.

---

## Rotation

```ts
app.use(riftex.csrf({
  secret: [
    process.env.CSRF_SECRET_NEW!,   // signs new responses
    process.env.CSRF_SECRET_OLD!,   // still verifies old cookies
  ],
}))
```

After everyone has refreshed (cookie max-age elapsed), drop the old key. Rotation makes secret leakage recoverable without invalidating in-flight sessions.

---

## What CSRF does NOT replace

- It does not prevent same-origin XSS exfiltrating the cookie.
- It does not authenticate the user; pair it with `sessionMiddleware` or a bearer-token plugin.
- It does not rate-limit; pair it with `riftex.rateLimit` on auth endpoints.

Use it together with the rest of the security layer (TLS, secure session cookies, content-security-policy, helmet equivalents) — not as a substitute.
