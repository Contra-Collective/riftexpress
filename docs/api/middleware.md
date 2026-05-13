# Built-in middleware

Everything below ships in the core `'riftexpress'` package — no extra installs. Most are exposed as static helpers on the `riftex` factory (`riftex.json`, `riftex.cors`, `riftex.static`, `riftex.sse`, `riftex.rateLimit`); a few are named exports (`sessionMiddleware`, `startKeepAlive`).

## `riftex.json(opts?)` and `riftex.urlencoded(opts?)`

```ts
riftex.json(opts?: { limit?: number }): RiftexMiddleware
riftex.urlencoded(opts?: { limit?: number }): RiftexMiddleware
```

**Both are zero-cost no-op stubs.** Body parsing in RiftExpress is lazy — `ctx.body.json()` and `ctx.body.urlencoded()` parse on demand. These factories exist so existing Express migration code (`app.use(express.json())`) compiles and reads naturally without rewriting. The `limit` option is currently ignored; pass `maxBytes` directly to the body method instead.

```ts
app.use(riftex.json())                    // no-op
app.post('/users', async (ctx) => {
  const body = await ctx.body.json(undefined, 5_000_000)  // 5 MiB cap here
  // ...
})
```

---

## `riftex.static(root, opts?)`

```ts
riftex.static(root: string, opts?: StaticOptions): RiftexMiddleware
```

Serve files from a directory.

### `StaticOptions`

```ts
interface StaticOptions {
  index?: string | false      // default 'index.html' — serve when a directory is requested. false disables.
  maxAge?: number             // default 0 — Cache-Control: max-age, in MILLISECONDS (Express convention)
  extensions?: string[]       // default [] — fallback extensions to try when path doesn't exist
  dotfiles?: 'allow' | 'deny' | 'ignore'  // default 'ignore' — call next()
}
```

### Features

- **Weak ETags** of the form `W/"<size>-<mtime>"`.
- **Conditional GET** via `If-None-Match` → 304. (`If-Modified-Since` is not honored — known gap, see [README](../../README.md#roadmap-and-known-gaps).)
- **Range requests** — `Range: bytes=N-M` returns 206 with `Content-Range`.
- **MIME negotiation** from extension via an internal map; unknown extensions fall back to `application/octet-stream`.
- **Path traversal protection** — `..` segments resolving outside `root` return 403.
- **Dotfile policy** — `'ignore'` (default) calls `next()` so routes can 404, `'deny'` returns 403, `'allow'` serves normally.

```ts
app.use(riftex.static('./public'))

app.use('/assets', riftex.static('./public', {
  maxAge: 60_000,
  extensions: ['html'],
  dotfiles: 'deny',
}))
```

Known gap: HEAD requests on static files currently fall through to `next()` instead of returning headers-only. Track in the [roadmap](../roadmap.md).

---

## `riftex.cors(opts?)`

```ts
riftex.cors(opts?: CorsOptions): RiftexMiddleware
```

Handle simple requests, preflights, and `Vary: Origin` whenever the origin is reflected from the request.

### `CorsOptions`

```ts
interface CorsOptions {
  origin?: CorsOrigin                   // default '*'
  methods?: string[]                    // default GET HEAD PUT PATCH POST DELETE
  allowedHeaders?: string[]             // default: mirror Access-Control-Request-Headers
  exposedHeaders?: string[]             // default: header omitted
  credentials?: boolean                 // default false; throws at construction with origin: '*'
  maxAge?: number                       // default: header omitted (preflight cache seconds)
  optionsSuccessStatus?: number         // default 204
}

type CorsOrigin =
  | boolean                             // true = reflect; false = disable
  | string                              // exact match, or '*' for wildcard
  | string[]                            // allowlist, exact match
  | RegExp                              // tested against request Origin
  | CorsOriginFn

type CorsOriginFn = (origin: string, ctx: RiftexContext) =>
  boolean | string | Promise<boolean | string>
```

Preflight (`OPTIONS` with `Access-Control-Request-Method`) is handled inline: the middleware writes the negotiated response and does NOT call `next()`. Simple requests get the appropriate `Access-Control-*` headers stamped before the chain continues.

```ts
app.use(riftex.cors({
  origin: ['https://app.example.com', 'https://admin.example.com'],
  credentials: true,
  exposedHeaders: ['x-trace-id'],
  maxAge: 3600,
}))
```

---

## `riftex.sse(ctx)` and `startKeepAlive(stream, intervalMs?)`

```ts
import { sse, startKeepAlive } from 'riftexpress'
// or via the factory: riftex.sse(ctx)

function sse(ctx: RiftexContext): SseStream
function startKeepAlive(stream: SseStream, intervalMs?: number): () => void
```

### `SseStream`

```ts
interface SseStream {
  send(event: SseEvent | string): void
  comment(text: string): void
  close(): void
  readonly closed: boolean
}
```

Calling `sse(ctx)` sets `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`, then wires a `PassThrough` into `ctx.stream(..., 'text/event-stream; charset=utf-8')`. The returned stream gives you frame-level control.

### `SseEvent`

```ts
interface SseEvent {
  data: string | object   // strings are written verbatim; objects are JSON-encoded
  event?: string          // 'event:' field
  id?: string             // 'id:' field
  retry?: number          // 'retry:' field, milliseconds
}
```

Multi-line `data` is split per spec — each `\n` produces a separate `data:` line in the frame.

### `startKeepAlive(stream, intervalMs = 15_000)`

Send a `:keepalive` comment frame every `intervalMs` ms. Returns a cancel function. The interval timer is `unref()`'d so it never holds the event loop alive on its own; it also self-cancels when `stream.closed` becomes true.

```ts
app.get('/events', (ctx) => {
  const stream = riftex.sse(ctx)
  const cancel = startKeepAlive(stream, 15_000)

  let n = 0
  const t = setInterval(() => {
    if (stream.closed) { clearInterval(t); cancel(); return }
    stream.send({ event: 'tick', id: String(n), data: { n: n++ } })
  }, 1000)
})
```

---

## `riftex.rateLimit(opts?)`

```ts
riftex.rateLimit(opts?: RateLimitOptions): RiftexMiddleware
```

Fixed-window in-memory rate limiter. Each key is allowed at most `max` requests per `windowMs`. Over-limit responses return 429 with `Retry-After` and a JSON body. Passing responses get `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (unix seconds).

### `RateLimitOptions`

```ts
interface RateLimitOptions {
  windowMs?: number                                       // default 60_000
  max?: number                                            // default 100
  keyGenerator?: (ctx: RiftexContext) => string           // default reads X-Forwarded-For, then X-Real-IP, then 'unknown'
  skip?: (ctx: RiftexContext) => boolean                  // default: never skip
  store?: RateLimitStore                                  // default: in-process MemoryStore
}

interface RateLimitStore {
  hit(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>
  reset(key: string): Promise<void>
}
```

The default `MemoryStore` is exported as `RateLimitMemoryStore` for tests. Its cleanup interval is `unref()`'d so it never holds the event loop alive. Swap in a Redis-backed store (or any other) when running multiple replicas — the store interface is Promise-returning so distributed implementations fit cleanly.

### Default key-generator pitfall

The default `keyGenerator` reads `X-Forwarded-For` (first hop) then `X-Real-IP`. **Without an upstream proxy that strips client-supplied values, both headers are forgeable** — an attacker can rotate `X-Forwarded-For: <random>` per request and never get rate-limited. In production behind a proxy:

- Set `trustProxy` on the app (`riftex({ trustProxy: 'loopback' })` for a local-only proxy).
- Either supply a `keyGenerator: (ctx) => ctx.ip` (which will then walk the chain per your trust policy), or use a CIDR/keyword `trustProxy` that matches your actual edge.

Throws at construction if `windowMs <= 0` or `max <= 0`.

```ts
app.use(riftex.rateLimit({
  windowMs: 60_000,
  max: 100,
  keyGenerator: (ctx) => ctx.ip,
  skip: (ctx) => ctx.path.startsWith('/health'),
}))
```

---

## `sessionMiddleware(opts)`

```ts
import { sessionMiddleware, type Session } from 'riftexpress'

function sessionMiddleware(opts: SessionOptions): RiftexMiddleware
```

Cookie-backed session middleware. HMAC-SHA256-signed session ids (18 random bytes / 144 bits), `crypto.timingSafeEqual` verification, secret rotation, in-process default store.

### `SessionOptions`

```ts
interface SessionOptions {
  secret: string | string[]              // index 0 signs; all entries verify (rotation)
  cookieName?: string                    // default 'riftex.sid'
  maxAgeSeconds?: number                 // default 604_800 (7 days)
  rolling?: boolean                      // default false; refresh expiry on every request
  cookie?: SessionCookieOptions
  store?: SessionStore                   // default in-process SessionMemoryStore
}

interface SessionCookieOptions {
  domain?: string
  path?: string                          // default '/'
  httpOnly?: boolean                     // default true
  sameSite?: 'lax' | 'strict' | 'none'   // default 'lax'
  secure?: boolean                       // default false
}
```

### `Session` (attached as `ctx.session`)

```ts
interface Session {
  readonly id: string
  readonly data: Readonly<Record<string, unknown>>
  get<T = unknown>(key: string): T | undefined
  set(key: string, value: unknown): void
  delete(key: string): void
  destroy(): Promise<void>
  regenerate(): Promise<void>     // new id, same data — use after privilege change
}
```

Mutations (`set`, `delete`, `destroy`, `regenerate`) mark the session dirty so the middleware persists changes after the handler returns.

### `SessionStore`

```ts
interface SessionStore {
  get(id: string): Promise<Record<string, unknown> | null>
  set(id: string, data: Record<string, unknown>, ttlSeconds: number): Promise<void>
  destroy(id: string): Promise<void>
  touch?(id: string, ttlSeconds: number): Promise<void>   // optional, used by rolling sessions
}
```

The default `SessionMemoryStore` is exported for tests. Swap in Redis/Postgres for clustered deployments — implementations must be safe to call concurrently for distinct ids; per-id ordering is the caller's concern.

### Module-augmentation pattern for typed `ctx.session`

```ts
import { sessionMiddleware, type Session } from 'riftexpress'

declare module 'riftexpress' {
  interface RiftexContext {
    session: Session
  }
}

const app = riftex()
app.use(sessionMiddleware({
  secret: [process.env.SESSION_SECRET!, ...rotatedSecrets],
  cookie: { secure: true, sameSite: 'lax', httpOnly: true },
}))

app.post('/login', async (ctx) => {
  const { user } = await ctx.body.json()
  await ctx.session.regenerate()              // fresh id against fixation
  ctx.session.set('userId', user.id)
  return { ok: true }
})

app.post('/logout', async (ctx) => {
  await ctx.session.destroy()
  return { ok: true }
})
```
