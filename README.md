# RiftExpress

> Express ergonomics, Hono/Fastify-class throughput. A typed HTTP framework for Node 20+ and Bun 1.1+.

```
                      __  ______
   _____  _  __     /   |/_  __/ ___  _  ____  ____   ___  _____ _____
  / ___/ | |/_/    / /| | / /  / _ \| |/_/ _ \/ ___/ / _ \/ ___// ___/
 / /     |>  <    / ___ |/ /  /  __/>  </ __/ /     /  __(__  )(__  )
/_/    /_/|_|   /_/  |_/_/   \___/_/|_|\___/_/      \___/____//____/
```

RiftExpress is what happens if you fix Express's three structural problems — linear routing, untyped `req`/`res`, and per-request allocation — without forcing developers to learn a new mental model. It's the same shape (`app.get`, `app.use`, mountable routers, drop-in middleware), with a typed `ctx` instead of `(req, res, next)`, and a router/dispatcher built for current-decade Node throughput.

**Status: alpha (v0.0.1).** API is mostly settled but still subject to change before 0.1.0. Use it for side projects and internal tools; revisit for production once 1.0 lands.

---

## Table of contents

- [Show me the code](#show-me-the-code)
- [Why RiftExpress](#why-riftexpress)
- [Performance](#performance)
- [Install](#install)
- [The 5-minute Express → RiftExpress diff](#the-5-minute-express--riftexpress-diff)
- [Core concepts](#core-concepts)
  - [App + Router](#app--router)
  - [RexContext](#rexcontext)
  - [Middleware](#middleware)
  - [Body parsing](#body-parsing)
  - [Response reflection](#response-reflection)
  - [Errors](#errors)
  - [Plugins](#plugins)
  - [Trust-proxy](#trust-proxy)
- [Built-in middleware](#built-in-middleware)
  - [`rex.json` / `rex.urlencoded`](#rexjson--rexurlencoded)
  - [`rex.static`](#rexstatic)
  - [`rex.cors`](#rexcors)
  - [`rex.sse` (Server-Sent Events)](#rexsse-server-sent-events)
  - [`rex.rateLimit`](#rexratelimit)
  - [`sessionMiddleware`](#sessionmiddleware)
- [Transports](#transports)
  - [Node `http` (default)](#node-http-default)
  - [Bun.serve](#bunserve)
  - [HTTP/2 (h2 + h2c)](#http2-h2--h2c)
  - [WebSocket](#websocket)
  - [Graceful shutdown](#graceful-shutdown)
- [Express compatibility shim](#express-compatibility-shim)
- [CLI scaffolder](#cli-scaffolder)
- [Schema validation](#schema-validation)
- [Reference application](#reference-application)
- [Packages](#packages)
- [Examples](#examples)
- [Architecture and design notes](#architecture-and-design-notes)
- [Repo layout](#repo-layout)
- [Development](#development)
- [Roadmap and known gaps](#roadmap-and-known-gaps)
- [Contributing](#contributing)
- [License](#license)

---

## Show me the code

```ts
import { rex } from 'riftexpress'

const app = rex()

app.use(async (ctx, next) => {
  const start = Date.now()
  await next()
  console.log(`${ctx.method} ${ctx.path} -> ${ctx._statusCode} ${Date.now() - start}ms`)
})

app.get('/', () => 'hello')
app.get('/users/:id', (ctx) => ({ id: ctx.params.id }))
app.post('/echo', async (ctx) => ctx.body.json())

const server = await app.listen(3000)
console.log(`listening on http://localhost:${server.port}`)
```

That's a full server. No `res.send`. No `body-parser`. No `app.set('case sensitive routing', true)`. Return a value and RiftExpress reflects it to the wire — object → JSON, string → text/html, `Buffer` → octet-stream, `Readable` → stream, `undefined` → 204. Call `ctx.json(...)` when you want explicit control over status or headers.

---

## Why RiftExpress

| Pain point | Express | Hono / Fastify | RiftExpress |
|---|---|---|---|
| Router speed at 1000 routes | O(n) linear scan | O(k) trie | O(k) radix trie + wildcard backtrack |
| `req` / `res` types | `any` in practice | strict, but unfamiliar surface | strict, Express-shaped |
| Per-request allocation | new `req`/`res`/`next` each request | varies | pooled `RexContext`, lazy getters |
| Middleware composition | re-walked per request | compose-on-register | lazy compose with dirty-bit recompose |
| Body parsing | `body-parser` middleware always runs | always-on parsing | lazy via `ctx.body.json()` |
| Default body size limit | 100 KB (`body-parser`) | varies | 100 KB (matches Express) |
| Bun support | community shim | varies | first-class adapter |
| Migration cost from Express | n/a | high | low |

The pitch in one sentence: **the shortest path from a working Express app to throughput competitive with Hono and Fastify.**

---

## Performance

Honest framing — separate Node child processes per framework, 5 samples + warmup, autocannon `-c 100 -d 5`, Node 24 on a Windows dev machine. Mean requests/sec:

| Scenario               | Express | Fastify | Hono   | **RiftExpress** | vs Express |
|------------------------|---------|---------|--------|-----------------|------------|
| `GET /` returning JSON | 14,691  | 30,162  | 22,131 | **31,221**      | **2.13×**  |
| `POST /echo` JSON body | 17,352  | 14,871  | 10,062 | **27,726**      | **1.60×**  |
| 10-middleware stack    | 24,015  | 23,531  | 24,327 | **31,081**      | **1.29×**  |

RiftExpress is the fastest of the four in all three scenarios on this machine.

**Caveats** (read these before quoting numbers):
- Single dev machine, no CPU pinning, no thermal control.
- One run series per scenario (5 samples).
- Framework versions: Express `^4.21`, Fastify `^5.0`, Hono `^4.6` — pinned in `benchmarks/package.json` but not minor-locked.
- Hono's body-json number is suspiciously low. Investigate before publishing publicly.
- Bun adapter not benchmarked yet.

For publishable numbers you need isolated hardware + many runs + pinned versions. The benchmarks here are local regression detectors.

Reproduce on your hardware:

```sh
cd benchmarks
npx tsx scenarios/v2/hello.ts
npx tsx scenarios/v2/body.ts
npx tsx scenarios/v2/middleware.ts
```

---

## Install

```sh
npm install riftexpress
```

Optional packages by use case:

```sh
# Bun.serve adapter
npm install riftexpress riftexpress-bun

# Express middleware compatibility (cors, helmet, etc.)
npm install riftexpress riftexpress-compat

# Project scaffolder
npm install -g riftexpress-cli
rex new my-api
```

**Requirements:** Node 20+. Bun 1.1+ for the Bun adapter. WebSocket support requires installing `ws` as a peer dep.

---

## The 5-minute Express → RiftExpress diff

```ts
// Express                                      // RiftExpress
import express from 'express'                   import { rex } from 'riftexpress'
const app = express()                           const app = rex()

app.use(express.json())                         app.use(rex.json())  // (no-op, parsing is lazy)

app.use((req, res, next) => {                   app.use(async (ctx, next) => {
  req.startedAt = Date.now()                      ctx.state.startedAt = Date.now()
  next()                                          await next()
})                                              })

app.get('/users/:id', (req, res) => {           app.get('/users/:id', (ctx) =>
  res.json({ id: req.params.id })                 ({ id: ctx.params.id }))
})

app.post('/users', (req, res) => {              app.post('/users', async (ctx) => {
  const body = req.body                           const body = await ctx.body.json()
  // ...                                          // ...
  res.status(201).json(user)                      return ctx.json(user, 201)
})                                              })

const r = express.Router()                      const r = rex.Router()
r.get('/health', (req, res) => res.json({ok:1}))r.get('/health', () => ({ ok: 1 }))
app.use('/api', r)                              app.use('/api', r)

app.use((err, req, res, next) => {              app.onError((err, ctx) => {
  res.status(500).json({err: err.message})        ctx.json({ err: err.message }, 500)
})                                              })

app.listen(3000)                                await app.listen(3000)
```

Breakable changes:
1. **Handlers may return values.** `return obj` is `res.json(obj)`; `return 'text'` is `res.text(...)`. Calling `ctx.json(...)` explicitly still works.
2. **Body parsing is lazy.** `app.use(rex.json())` is a no-op stub for ergonomics; the actual parse happens in `ctx.body.json()` inside your handler.
3. **`ctx.state` is the per-request scratch space**, not `ctx.user = ...` directly (though plugins can decorate `ctx` to enable that).

That's the whole list. Everything else from the Express mental model carries over verbatim.

---

## Core concepts

### App + Router

```ts
import { rex, Router } from 'riftexpress'

const app = rex({ poolSize: 1024, trustProxy: false })

// HTTP methods — same surface as Express
app.get('/', handler)
app.post('/users', handler)
app.put('/users/:id', handler)
app.patch('/users/:id', handler)
app.delete('/users/:id', handler)
app.head('/users/:id', handler)
app.options('/users/:id', handler)
app.method('OPTIONS', '/anywhere', handler)  // any method by string

// Mountable routers
const api = Router()
api.get('/health', () => ({ ok: true }))
api.use('/notes', notesRouter)               // routers can mount routers
app.use('/api', api)

// Middleware
app.use(globalMiddleware)
app.use('/admin', adminOnlyMiddleware)
app.use('/admin', adminRouter)               // mount middleware OR router

// Lifecycle
await app.compose()                          // pre-warm; runs lazily on first request otherwise
const server = await app.listen(3000, '0.0.0.0')
await server.close({ gracefulTimeoutMs: 10_000 })
```

**Path syntax.** `:param` (required), `:param?` (optional), `*wildcard` (greedy tail). Static segments win over params, params win over wildcards, but the matcher backtracks one level to a wildcard if the param branch dead-ends.

**Composition timing.** Registration is journaled, not eagerly composed. The trie + composed handlers are built on first request (or via `app.compose()`). Adding routes after `listen()` sets a dirty bit and triggers recompose on the next request — tests that register routes per-test work without ceremony.

### RexContext

```ts
class RexContext<Params = Record<string, string>> {
  // Request
  method: HttpMethod              // 'GET' | 'POST' | ...
  url: string                     // path + ?query
  path: string                    // no query
  rawQuery: string
  query: URLSearchParams          // lazy
  params: Params                  // route params
  headers: IncomingHttpHeaders    // lowercased per Node convention
  body: RexBody                   // lazy parsers
  state: Record<string, unknown>  // per-request scratch

  // Network info (trust-proxy aware)
  ip: string                      // client IP (XFF-aware if trustProxy enabled)
  ips: readonly string[]          // full forwarded chain
  protocol: 'http' | 'https'
  secure: boolean
  hostname: string
  remoteAddress: string           // immediate socket peer
  baseProtocol: 'http' | 'https'  // underlying transport

  // Response setters (chainable)
  status(code: number): this
  set(name: string, value: string | string[]): this
  setHeader(name: string, value: string | string[]): this
  getHeader(name: string): string | string[] | undefined

  // Response writers
  json(body: unknown, status?: number): void
  text(body: string, status?: number): void
  html(body: string, status?: number): void
  send(body: Buffer | string, status?: number): void
  redirect(location: string, status?: number): void  // default 302
  stream(readable: Readable, contentType?: string): void
}
```

The class is pool-bound: one instance per pool slot, reused across requests. `reset()` zeros every field by reassignment to keep the V8 hidden class stable.

### Middleware

```ts
type RexMiddleware = (ctx: RexContext, next: () => Promise<void>) => unknown | Promise<unknown>
```

Same dispatch model as Koa: `await next()` in the middle, do work before/after. Errors thrown anywhere in the chain bubble up to `app.onError`.

### Body parsing

```ts
ctx.body.json<T>(schema?, maxBytes?: number): Promise<T>
ctx.body.text(maxBytes?: number): Promise<string>
ctx.body.urlencoded(maxBytes?: number): Promise<Record<string, string>>
ctx.body.buffer(maxBytes?: number): Promise<Buffer>
ctx.body.stream(): Readable
ctx.body.multipart(opts?: MultipartOptions): Promise<MultipartResult>
```

Default `maxBytes` is **100,000** (matches Express's `body-parser` default). Override per-call. The schema arg accepts:
1. Standard Schema v1 (any validator that exposes `["~standard"]`)
2. Zod-like `safeParse(input)`
3. Plain `parse(input): T`

Validation failures throw `RexValidationError` with a `fields` map. Body-too-large throws `RexPayloadTooLargeError` mid-stream (no post-buffer rejection).

### Response reflection

| Return value           | Wire output                  |
|------------------------|------------------------------|
| `undefined` / `null`   | 204 No Content               |
| `string` starting `<`  | 200 text/html                |
| other `string`         | 200 text/plain               |
| `Buffer` / `Uint8Array`| 200 application/octet-stream |
| `Readable`             | 200 streamed                 |
| any object/array       | 200 application/json         |

If a `ctx.json/text/html/send/redirect/stream` helper has been called, the return value is ignored.

### Errors

```ts
import {
  RexError,
  RexNotFoundError,        // 404
  RexUnauthorizedError,    // 401
  RexMethodNotAllowedError,// 405 (auto-thrown on path match + method miss)
  RexPayloadTooLargeError, // 413
  RexValidationError,      // 422 with .fields
  RexBadRequestError,      // 400
} from 'riftexpress'

app.onError((err, ctx) => {
  if (err instanceof RexValidationError) {
    return ctx.json({ error: err.message, fields: err.fields }, 422)
  }
  if (err instanceof RexError) throw err  // delegate to default boundary
  ctx.json({ error: 'internal' }, 500)
})
```

The default boundary serializes any `RexError` as `{ error, code, fields? }` with the right status. Unknown errors become 500s. `RexMethodNotAllowedError` writes the `Allow` response header automatically.

### Plugins

```ts
import { rex, type RexPlugin } from 'riftexpress'

interface User { id: string; email: string }

const auth: RexPlugin<{ secret: string }> = (app, opts) => {
  app.decorate('user', async (ctx) => {
    const token = ctx.headers.authorization?.split(' ')[1]
    if (!token) throw new RexUnauthorizedError()
    return verifyToken(token, opts.secret) as User
  })
  app.hooks.onRequest((ctx) => {
    ctx.state.requestId = crypto.randomUUID()
  })
}

const app = rex()
await app.register(auth, { secret: process.env.JWT_SECRET! })

declare module 'riftexpress' {
  interface RexContext {
    user: User
  }
}

app.get('/me', (ctx) => ctx.user)  // typed, lazily resolved on first access
```

Lifecycle hooks: `onRoute`, `onCompose`, `onRequest`, `onResponse`, `onError`. Decorators come in two flavors: lazy (`decorate` — `defineProperty` self-replacing getter, computed on first access) and eager (`decorateRequest` — assigned at request start). Hot-path checks `hooks.hasAny()` and `decorators.hasAny()` so plugin-free apps pay zero overhead.

### Trust-proxy

```ts
const app = rex({ trustProxy: 'loopback' })

// Then in handlers:
ctx.ip          // real client IP after walking the X-Forwarded-For chain
ctx.protocol    // 'https' if X-Forwarded-Proto: https
ctx.hostname    // X-Forwarded-Host (if set), else Host header
```

Mirrors Express's `app.set('trust proxy', ...)`:

| Value | Behavior |
|---|---|
| `false` (default) | Never trust XFF — `ctx.ip` is the socket peer |
| `true` | Trust the entire chain — leftmost XFF entry wins |
| `number n` | Trust `n` upstream hops |
| `'loopback'` | Trust 127.0.0.0/8, ::1 |
| `'linklocal'` | Trust 169.254.0.0/16, fe80::/10 |
| `'uniquelocal'` | Trust 10/8, 172.16/12, 192.168/16, fc00::/7 |
| `'10.0.0.0/8'` (CIDR) | Trust matching addresses |
| `string[]` | Multiple of any of the above |
| `(ip, hopIdx) => boolean` | Custom predicate |

---

## Built-in middleware

### `rex.json` / `rex.urlencoded`

Stub middleware for Express compatibility. Body parsing is lazy via `ctx.body.json()` / `ctx.body.urlencoded()`, so these are no-ops. They exist so existing Express migration code (`app.use(express.json())`) compiles and reads naturally.

### `rex.static`

```ts
app.use(rex.static('./public', {
  index: 'index.html',     // default; set false to disable
  maxAge: 60_000,          // ms — sets Cache-Control: public, max-age=60
  extensions: ['html'],    // try /foo + /foo.html when /foo not found
  dotfiles: 'ignore',      // 'allow' | 'deny' | 'ignore' (default: ignore → next())
}))
```

Ships with weak ETags (`W/"size-mtime"`), conditional GET (`If-None-Match` → 304), range requests (`Range: bytes=N-M` → 206), MIME from extension (extensible map), and path-traversal protection (`../etc/passwd` → 403).

### `rex.cors`

```ts
app.use(rex.cors({
  origin: 'https://app.example.com',  // or true | string[] | RegExp | (origin, ctx) => boolean | string | Promise<>
  methods: ['GET', 'POST', 'PUT'],    // default: GET HEAD PUT PATCH POST DELETE
  allowedHeaders: ['x-trace-id'],     // default: mirror Access-Control-Request-Headers
  exposedHeaders: ['x-trace-id'],
  credentials: true,                   // throws at construction with origin: '*'
  maxAge: 3600,                        // preflight cache seconds
  optionsSuccessStatus: 204,
}))
```

Handles simple requests, preflights (responds 204 with negotiated methods/headers, does NOT call `next()`), and `Vary: Origin` whenever the origin is reflected from the request.

### `rex.sse` (Server-Sent Events)

```ts
import { rex, sse, startKeepAlive } from 'riftexpress'

app.get('/events', (ctx) => {
  const stream = sse(ctx)
  startKeepAlive(stream, 15_000)

  let n = 0
  const timer = setInterval(() => {
    stream.send({ event: 'tick', id: String(n), data: { n: n++ } })
    if (n >= 10) {
      clearInterval(timer)
      stream.close()
    }
  }, 1000)
})
```

`SseStream` API: `send(event | string)`, `comment(text)`, `close()`, `closed: boolean`. Multi-line `data` is split per spec. Object data is JSON-stringified.

### `rex.rateLimit`

```ts
app.use(rex.rateLimit({
  windowMs: 60_000,
  limit: 100,
  // default keygen reads X-Forwarded-For — make sure trustProxy is set!
  keyGenerator: (ctx) => ctx.ip,
  skip: (ctx) => ctx.path.startsWith('/health'),
}))
```

Fixed-window in-memory store (`MemoryStore`) by default, with cleanup interval `unref()`'d so it never holds the event loop alive. Pluggable via the `RateLimitStore` interface (Promise-returning so a Redis-backed store fits cleanly). Sets `X-RateLimit-{Limit,Remaining,Reset}` on every response and `Retry-After` on 429s.

### `sessionMiddleware`

```ts
import { sessionMiddleware, type Session } from 'riftexpress'

app.use(sessionMiddleware({
  secret: [process.env.SESSION_SECRET!, ...rotatedSecrets],
  cookieName: 'rex.sid',
  maxAgeSeconds: 7 * 86_400,
  rolling: false,
  cookie: { secure: true, sameSite: 'lax', httpOnly: true },
}))

declare module 'riftexpress' {
  interface RexContext { session: Session }
}

app.post('/login', async (ctx) => {
  const { user } = await ctx.body.json()
  await ctx.session.regenerate()       // new id, fresh against fixation
  ctx.session.set('userId', user.id)
  return { ok: true }
})

app.post('/logout', async (ctx) => {
  await ctx.session.destroy()
  return { ok: true }
})
```

HMAC-SHA256-signed cookies, 18-byte (144-bit) ids, `crypto.timingSafeEqual` verification, secret rotation (index 0 signs, all entries verify), `regenerate()` for post-login fixation defense, pluggable `SessionStore` interface (default `SessionMemoryStore`).

---

## Transports

### Node `http` (default)

```ts
const app = rex()
const server = await app.listen(3000)
```

Uses `node:http` directly. No translation layer to WinterCG `Request`/`Response` — adapter writes straight from `IncomingMessage` to the `RexContext`, and the `RexContext` straight to the `ServerResponse`.

### Bun.serve

```ts
import { rex } from 'riftexpress'
import { BunAdapter } from 'riftexpress-bun'

const app = rex({ transport: new BunAdapter() })
await app.listen(3000)
```

Wraps `Bun.serve()` with a Web-Streams ↔ `node:stream` bridge so existing `RexBody` parsers work unchanged. Lazy body — request body is not materialized unless `ctx.body.*` is called.

### HTTP/2 (h2 + h2c)

```ts
import { rex, Http2Adapter, Http2cAdapter } from 'riftexpress'
import { readFileSync } from 'node:fs'

// h2c (cleartext HTTP/2)
const app = rex({ transport: new Http2cAdapter() })
await app.listen(3000)

// h2 (TLS)
const tlsApp = rex({
  transport: new Http2Adapter({
    cert: readFileSync('cert.pem'),
    key: readFileSync('key.pem'),
    allowHttp1: true,           // ALPN fallback to HTTP/1.1
  }),
})
await tlsApp.listen(443)
```

Built on `node:http2`. Pseudo-headers (`:method`, `:path`, `:status`, `:scheme`, `:authority`) handled internally; user code reads regular headers. `Transfer-Encoding: chunked` is stripped from responses (HTTP/2 has implicit framing).

### WebSocket

WebSocket support is opt-in via the `ws` peer dependency.

```sh
npm install ws @types/ws
```

```ts
import { rex, enableWebSockets } from 'riftexpress'

const app = rex()
enableWebSockets(app)

app.ws('/echo', (sock) => {
  sock.on('message', (msg) => sock.send(msg))
})

// Or hand the underlying http.Server to your own integrator:
app.upgradeWith((httpServer) => {
  // wire up `ws`, socket.io, etc.
})

await app.listen(3000)
```

Uses `WebSocketServer({ noServer: true })` and hooks the `upgrade` event on the underlying `http.Server`. Per-path handlers are registered up front; unknown paths get the socket destroyed cleanly.

### Graceful shutdown

```ts
import { rex, gracefulShutdown } from 'riftexpress'

const app = rex()
const server = await app.listen(3000)

gracefulShutdown(server, {
  gracefulTimeoutMs: 10_000,                  // force-close idle keep-alives after 10s
  signals: ['SIGTERM', 'SIGINT'],
  onShutdown: async () => {
    await db.close()
    await queue.flush()
  },
})
```

A second signal during shutdown → immediate `exit(1)` (force quit). Without graceful shutdown wired, your server dies immediately on SIGTERM and in-flight requests are dropped. Every production deployment needs this.

---

## Express compatibility shim

```sh
npm install riftexpress riftexpress-compat cors helmet
```

```ts
import { rex } from 'riftexpress'
import { expressCompat } from 'riftexpress-compat'
import cors from 'cors'
import helmet from 'helmet'

const app = rex()
app.use(expressCompat(cors({ origin: 'https://app.example.com' })))
app.use(expressCompat(helmet()))
```

The shim wraps `(req, res, next)` middleware so it can run inside a RiftExpress middleware chain. The `req` and `res` shims expose enough surface for header-stamping, cookie parsing, simple body work, and short-circuit responses.

**Compatibility status** (validated end-to-end in `packages/riftexpress-compat/test/e2e.test.ts`):

| Middleware | Status | Notes |
|---|---|---|
| `cors` | supported | full feature parity |
| `helmet` | supported | full feature parity |
| `cookie-parser` | supported | `req.cookies` populated, mirrored to `ctx.state` |
| `passport.initialize` | supported | `passport.authenticate` is partial (depends on session) |
| `morgan` | partial | logging works; `:response-time` token may be inaccurate |
| `express-rate-limit` | partial | works with `validate: false` and a custom `keyGenerator` |
| `compression` | unsupported | needs `res.write`/`res.end` ownership the shim doesn't proxy — use a reverse proxy |
| `body-parser` | unsupported | use native `ctx.body.json()` / `ctx.body.urlencoded()` |
| `express-session` | unsupported | silently no-ops — use native `sessionMiddleware` |
| `multer` | unsupported | owns the request stream — use native `ctx.body.multipart()` |

Full matrix and failure modes in [`packages/riftexpress-compat/COMPATIBILITY.md`](packages/riftexpress-compat/COMPATIBILITY.md).

---

## CLI scaffolder

```sh
npm install -g riftexpress-cli

rex new my-api                      # default template
rex new my-bun-api --bun            # uses BunAdapter
rex new tiny --minimal              # 10-line hello world
rex new my-api --force              # overwrite existing dir
rex --version
rex --help
```

Templates ship with: `package.json`, `tsconfig.json`, `.gitignore`, `src/index.ts`, `README.md`. Zero runtime dependencies (only Node built-ins). Requires Node 22+ (uses `--experimental-strip-types`).

---

## Schema validation

`ctx.body.json(schema)` accepts three validator shapes, detected in this order:

```ts
// 1. Standard Schema v1 (any validator with ["~standard"])
import { type } from 'arktype'
const User = type({ name: 'string', email: 'string' })
app.post('/users', async (ctx) => ctx.body.json(User))

// 2. Zod-like safeParse
import { z } from 'zod'
const User = z.object({ name: z.string(), email: z.string().email() })
app.post('/users', async (ctx) => ctx.body.json(User))

// 3. Plain { parse(input): T }
const User = {
  parse(input: unknown): { name: string } {
    if (typeof input !== 'object') throw new Error('expected object')
    return input as { name: string }
  },
}
app.post('/users', async (ctx) => ctx.body.json(User))
```

All three throw `RexValidationError` with a `fields: Record<string, string>` map on failure. Standard Schema v1 issues with structured paths are dot-joined (`['user', 'email']` → `'user.email'`).

---

## Reference application

[`apps/notes-api/`](apps/notes-api) is a small but realistic notes service that exercises the full feature surface:

- Bearer-token auth via a plugin (`app.register(authPlugin)`)
- `app.decorate('user', ...)` lazy decorator + `requireAuth` middleware
- Pino logger plugin with `onRequest` / `onResponse` hooks
- SQLite persistence (better-sqlite3) with FTS5 full-text search
- Mounted routers (`/api/users`, `/api/notes`, `/api/health`)
- Zod-validated request bodies via `ctx.body.json(Schema)`
- Custom error boundary with status-aware responses
- Real HTTP integration tests on ephemeral ports

Run it:

```sh
cd apps/notes-api
npm install
npm run dev
```

---

## Packages

| Package | Description |
|---|---|
| [`riftexpress`](packages/riftexpress) | Core framework — `rex()`, `Router`, `RexContext`, plugins, static, CORS, SSE, rate-limit, sessions, multipart, transports |
| [`riftexpress-compat`](packages/riftexpress-compat) | `expressCompat(mw)` shim for `(req, res, next)` middleware |
| [`riftexpress-bun`](packages/riftexpress-bun) | `BunAdapter` — drop-in transport for `Bun.serve()` |
| [`riftexpress-cli`](packages/riftexpress-cli) | `rex new <name> [--bun\|--minimal]` scaffolder |

Each package is independently publishable to npm.

---

## Examples

| Example | Demonstrates |
|---|---|
| [`examples/basic`](examples/basic) | Hello world, params, body, error handler, graceful shutdown, static files, decorator |
| [`examples/migrate-from-express`](examples/migrate-from-express) | Express version + RiftExpress version side by side, identical routes |
| [`examples/with-plugin`](examples/with-plugin) | Custom auth plugin, decorator, hooks, module augmentation |
| [`examples/with-bun`](examples/with-bun) | `BunAdapter` for `Bun.serve()` |

---

## Architecture and design notes

Five [Architecture Decision Records](docs/adr/) document the load-bearing choices:

1. [ADR 0001 — Radix trie router](docs/adr/0001-radix-trie-router.md): why we chose a radix trie over Express's linear scan or Hono's smart router
2. [ADR 0002 — Lazy composition with a dirty bit](docs/adr/0002-lazy-composition-with-dirty-bit.md): how registration is journaled and composed lazily, and why we don't freeze on listen
3. [ADR 0003 — Handler return-value reflection](docs/adr/0003-handler-return-value-reflection.md): why handlers return values instead of calling `res.send`
4. [ADR 0004 — Context object pool](docs/adr/0004-context-pool.md): per-request pooling for GC pressure, V8 hidden class stability
5. [ADR 0005 — Express compat shim scope](docs/adr/0005-express-compat-shim-scope.md): what's in, what's out, and why

---

## Repo layout

```
riftexpress/
├── packages/
│   ├── riftexpress/              # core
│   ├── riftexpress-compat/       # Express middleware shim
│   ├── riftexpress-bun/          # Bun.serve adapter
│   └── riftexpress-cli/          # rex new scaffolder
├── apps/
│   └── notes-api/                # reference CRUD service
├── examples/
│   ├── basic/
│   ├── migrate-from-express/
│   ├── with-plugin/
│   └── with-bun/
├── benchmarks/
│   ├── scenarios/                # v1 — in-process (deprecated)
│   └── scenarios/v2/             # separate-process bench vs Express/Fastify/Hono
├── docs/
│   ├── migration-guide.md
│   ├── plugins.md
│   ├── roadmap.md
│   └── adr/                      # 0001-0005
├── .github/workflows/
│   ├── ci.yml                    # Node 20/22/24 × ubuntu/windows
│   ├── bench.yml                 # nightly bench, artifact upload
│   ├── audit.yml                 # banned-packages scan
│   ├── publish.yml               # manual, alpha-gated npm publish
│   └── release.yml               # tag-driven GitHub Release
├── README.md, API.md, CHANGELOG.md, CONTRIBUTING.md, SECURITY.md, LICENSE
├── tsconfig.base.json, tsconfig.json
├── vitest.config.ts
└── package.json (npm workspaces)
```

---

## Development

```sh
git clone https://github.com/Contra-Collective/riftexpress.git
cd riftexpress
npm install

npm run typecheck          # tsc --noEmit across all workspaces
npm test                   # vitest run

# build the publishable core to dist/
npm run build --workspace packages/riftexpress

# run a benchmark scenario
cd benchmarks
npx tsx scenarios/v2/hello.ts
```

CI runs typecheck + tests on every push, matrix Node 20/22/24 × ubuntu-latest/windows-latest. Bench runs nightly on Node 22 ubuntu-latest, output uploaded as a workflow artifact.

---

## Roadmap and known gaps

See [docs/roadmap.md](docs/roadmap.md) for the full breakdown. Highlights:

**Shipped in v0.0.1:**
- All deliverables 1–10 from the original session plan
- HTTP/2, WebSocket, SSE, rate limit, session, multipart, trust-proxy
- CI matrix, ADRs, reference app, governance bundle

**Known issues:**
- Hono's body-json benchmark number looks low; investigate before publishing public comparisons
- Bun adapter not benchmarked yet (no Bun on the bench machine)
- Compat shim long-tail: middleware that own `res.end` (compression, express-session) silently misbehave — documented but worth surfacing better
- `ctx.query.parse(schema)` doesn't exist yet — only body validation has the schema affordance
- `ExtractParams` doesn't narrow constrained params (`:id(\\d+)` stays `string`)
- Static middleware doesn't honor `If-Modified-Since` (only `If-None-Match`)
- HEAD requests on static files fall through to `next()` instead of returning headers-only

**Deferred to next session:**
- Full benchmark matrix on CI hardware with pinned versions
- Native rate-limit Redis store
- Plugin scoping (Fastify-style sub-app affinity)
- TypeBox-specific bridge (Standard Schema covers it but a tighter integration could be cleaner)

---

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the relevant [ADR](docs/adr/) before opening a PR that changes a load-bearing design choice. Bug reports and design feedback welcome via GitHub Issues. Use [SECURITY.md](SECURITY.md) for vulnerability reports — do not file them as public issues.

---

## License

[MIT](LICENSE) © RiftExpress contributors.
