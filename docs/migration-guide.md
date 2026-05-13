# Express → RiftExpress Migration Guide

RiftExpress (`riftex`) is a small, typed HTTP framework with an Express-shaped API and a lazy-composed middleware pipeline. Most Express code ports over by renaming `app` → `riftex()` and dropping the `req, res, next` triple for a single `ctx`. There is **one intentional breaking change**: handlers return values instead of calling `res.send` / `res.json`. Whatever you `return` from a handler is reflected to the wire (object → JSON, string → text/html, `Buffer` → octet-stream, `Readable` → stream, `undefined` → 204). You can still call `ctx.json(...)` etc. explicitly when you want control over status or headers.

---

## Hello world

```ts
// Express
import express from 'express'
const app = express()
app.get('/', (req, res) => {
  res.send('hello')
})
app.listen(3000)
```

```ts
// RiftExpress
import { riftex } from 'riftexpress'
const app = riftex()
app.get('/', (ctx) => 'hello')
await app.listen(3000)
```

---

## Path params

```ts
// Express
app.get('/users/:id', (req, res) => {
  res.json({ id: req.params.id })
})
```

```ts
// RiftExpress — params are typed via ExtractParams<'/users/:id'>
app.get('/users/:id', (ctx) => ({ id: ctx.params.id }))
```

Optional params and wildcards work too:

```ts
app.get('/users/:id?', (ctx) => ctx.params.id ?? 'list')
app.get('/files/*path',  (ctx) => ctx.params.path)
```

---

## Query strings

```ts
// Express
app.get('/search', (req, res) => {
  res.json({ q: req.query.q })
})
```

```ts
// RiftExpress — ctx.query is a URLSearchParams (lazy parsed)
app.get('/search', (ctx) => ({ q: ctx.query.get('q') }))
```

If you need the raw string, use `ctx.rawQuery`.

---

## Request body parsing

JSON:

```ts
// Express
app.use(express.json())
app.post('/users', (req, res) => {
  res.json(req.body)
})
```

```ts
// RiftExpress — parsing is lazy; riftex.json() is a no-op stub for compat.
app.post('/users', async (ctx) => {
  const body = await ctx.body.json()
  return body
})
```

URL-encoded forms:

```ts
// Express
app.use(express.urlencoded({ extended: true }))
app.post('/form', (req, res) => res.json(req.body))
```

```ts
// RiftExpress
app.post('/form', async (ctx) => ctx.body.urlencoded())
```

Validate while parsing (Zod or any `{ parse(input): T }`):

```ts
import { z } from 'zod'
const Schema = z.object({ name: z.string() })

app.post('/users', async (ctx) => {
  const user = await ctx.body.json(Schema, /* maxBytes */ 64 * 1024)
  return user
})
```

A failed parse throws `RiftexValidationError` with a `fields` map.

---

## Response helpers

```ts
// Express
res.status(201).json({ ok: true })
res.type('text/plain').send('hi')
res.send('<h1>hi</h1>')          // express auto-detects html
res.redirect(302, '/login')
```

```ts
// RiftExpress
ctx.json({ ok: true }, 201)
ctx.text('hi')
ctx.html('<h1>hi</h1>')
ctx.redirect('/login')           // default 302
ctx.status(418).json({ teapot: true })
ctx.set('X-Trace', 't-123')
```

Or just return:

```ts
app.get('/a', (ctx) => ({ ok: true }))           // → 200 application/json
app.get('/b', (ctx) => 'hello')                  // → 200 text/plain
app.get('/c', (ctx) => '<h1>hi</h1>')            // → 200 text/html
app.get('/d', (ctx) => Buffer.from([1, 2, 3]))   // → 200 octet-stream
app.get('/e', (ctx) => undefined)                // → 204 No Content
```

---

## Middleware (sync and async)

```ts
// Express
app.use((req, res, next) => {
  req.startedAt = Date.now()
  next()
})

app.use(async (req, res, next) => {
  req.user = await loadUser(req.headers.authorization)
  next()
})
```

```ts
// RiftExpress — single signature, await next() instead of calling next()
app.use(async (ctx, next) => {
  ctx.state.startedAt = Date.now()
  await next()
})

app.use(async (ctx, next) => {
  ctx.state.user = await loadUser(ctx.headers.authorization)
  await next()
})
```

Per-request scratch space lives on `ctx.state` (typed as `Record<string, unknown>`).

---

## Routers

```ts
// Express
import { Router } from 'express'
const users = Router()
users.get('/', (req, res) => res.json([]))
users.get('/:id', (req, res) => res.json({ id: req.params.id }))
app.use('/users', users)
```

```ts
// RiftExpress
import { Router } from 'riftexpress'
const users = Router()
users.get('/',    (ctx) => [])
users.get('/:id', (ctx) => ({ id: ctx.params.id }))
app.use('/users', users)
```

Routers can mount routers:

```ts
const v1 = Router()
v1.use('/users', users)
app.use('/api/v1', v1)        // → /api/v1/users, /api/v1/users/:id
```

---

## Error handling

Express uses a 4-arg middleware:

```ts
// Express
app.use((err, req, res, next) => {
  res.status(500).json({ error: err.message })
})
```

RiftExpress has a dedicated `onError`:

```ts
// RiftExpress
import { RiftexError, RiftexValidationError } from 'riftexpress'

app.onError((err, ctx) => {
  if (err instanceof RiftexValidationError) {
    return ctx.json({ error: err.message, fields: err.fields }, 422)
  }
  if (err instanceof RiftexError) throw err  // re-throw to default boundary
  ctx.json({ error: 'internal' }, 500)
})
```

Re-throwing falls back to the default JSON error boundary
(`{ error, code, fields? }`).

---

## 404 handling

Unmatched routes throw `RiftexNotFoundError`, which the default boundary
serializes as a 404. To customize:

```ts
import { RiftexNotFoundError } from 'riftexpress'

app.onError((err, ctx) => {
  if (err instanceof RiftexNotFoundError) {
    return ctx.html('<h1>nope</h1>', 404)
  }
  throw err
})
```

You can also register a catch-all last:

```ts
app.use(async (ctx, next) => {
  await next()
  if (!ctx.getHeader('content-type')) ctx.json({ error: 'not found' }, 404)
})
```

---

## Static files

```ts
// Express
app.use(express.static('./public'))
```

```ts
// RiftExpress
app.use(riftex.static('./public'))
```

`riftex.static(root, opts?)` ships with ETag, conditional GET (`If-None-Match`),
range requests, MIME detection from extension, and a configurable directory
index (default `index.html`). Options include `index`, `maxAge` (milliseconds,
matching Express's convention), `extensions`, and `dotfiles` (`'allow' |
'deny' | 'ignore'`, default `'ignore'`).

```ts
app.use('/assets', riftex.static('./public', {
  maxAge: 60_000,
  extensions: ['html'],
  dotfiles: 'deny',
}))
```

---

## Express-style middleware via the compat shim

Pure-function Express middleware (cors, helmet, morgan, compression-ish
logic) works through the compat shim, which adapts the `(req, res, next)`
signature onto a `RiftexContext`.

```ts
import { riftex } from 'riftexpress'
import { expressCompat } from 'riftexpress-compat'
import cors from 'cors'
import helmet from 'helmet'

const app = riftex()
app.use(expressCompat(cors({ origin: 'https://example.com' })))
app.use(expressCompat(helmet()))
```

The shim proxies enough of `req` / `res` to satisfy header-stamping and
short-circuit responses. Anything that mutates `req.body`, owns the
socket, or reaches into Express internals is **not** supported — see
below.

---

## Known incompatibilities

These Express middleware packages will **not** work through the compat
shim and need native ports (or replacement) before v1.0:

| Package              | Why it doesn't shim                                         |
| -------------------- | ----------------------------------------------------------- |
| `multer`             | Owns the request stream and writes to `req.files`; clashes with lazy `ctx.body`. Needs a native `ctx.body.multipart()` API. |
| `passport`           | Strategies mutate `req.user` and call `req.logIn` / session APIs the shim doesn't provide. |
| `express-session`    | Hooks `res.end` to flush the session and depends on a cookie-jar contract we don't expose. |
| `csurf`              | Deprecated by its own author; use **`riftex.csrf({ secret })`** instead — see below. |
| `express-rate-limit` | Patches `res` and uses Express response lifecycle hooks; needs a native limiter middleware (planned). |

---

## Things that look the same but aren't

- **Handler return values are wire output.** Returning a string from a
  handler in Express does nothing; in RiftExpress it sends a 200 response.
  If you don't want this, call `ctx.json(...)` / `ctx.text(...)` and let
  the function return `undefined`.
- **Async middleware is the only kind.** There is no callback `next(err)`
  pattern — throw, or `await next()` and inspect after. Sync middleware
  still works (you don't have to mark it `async`), but `next()` always
  returns a `Promise<void>`.
- **`riftex.json()` and `riftex.urlencoded()` are no-op stubs.** Body parsing is
  lazy via `ctx.body.json()` / `ctx.body.urlencoded()`. The functions
  exist so `app.use(express.json())` lines port mechanically; they don't
  install a parser, configure limits, or mutate `ctx.body`. Pass
  `maxBytes` to the body method instead.
- **No `next('route')` semantics.** RiftExpress doesn't have Express's
  router-skip control flow. Use early `return` from a handler, branch
  inside one route, or split into separate routers.
- **Lazy composition, not frozen-after-listen.** You can `app.get(...)`
  after `app.listen(...)` and the next request will see it (a dirty flag
  triggers recomposition). Useful for tests; avoid in hot paths.

---

## CSRF protection (`csurf` → `riftex.csrf`)

Express's `csurf` package was deprecated by its maintainer in 2022 and never
had a clean replacement in the Express ecosystem. RiftExpress ships
`riftex.csrf(opts)` natively.

```ts
// Express + the (deprecated) csurf package
import csurf from 'csurf'
app.use(csurf({ cookie: true }))

app.get('/form', (req, res) => res.send(`<form>
  <input type="hidden" name="_csrf" value="${req.csrfToken()}">
</form>`))
```

```ts
// RiftExpress
import { riftex } from 'riftexpress'

app.use(riftex.csrf({
  secret: process.env.CSRF_SECRET!,    // required for cookie storage
  cookie: { sameSite: 'lax', secure: true },
}))

app.get('/form', (ctx) => `<form>
  <input type="hidden" name="_csrf" value="${ctx.csrfToken()}">
</form>`)
```

Two storage modes — `'cookie'` (default; double-submit with HMAC, no
session needed) and `'session'` (synchronizer pattern; pair with
`sessionMiddleware`). Failures throw `RiftexCsrfError` (HTTP 403). See
[docs/api/csrf.md](api/csrf.md) for the full surface.

---

## Plugins

Express has no formal plugin system — middleware is the only extension
point, and shared state has to be smuggled through `app.locals` or by
mutating `req`. RiftExpress ships an explicit one.

A plugin is just a function that receives the app and (optionally)
options: `app.register(plugin, opts?)`. Plugins can register lifecycle
hooks (`onRoute`, `onCompose`, `onRequest`, `onResponse`, `onError`) and
add typed properties to every `ctx` via `app.decorate(name, factory)`
(lazy, computed on first read) or `app.decorateRequest(name, factory)`
(eager, computed at request start). When no plugins are registered the
plugin path short-circuits and adds zero overhead to the hot path.

See [`docs/plugins.md`](./plugins.md) for the full surface, lifecycle
ordering, the `decorate` vs `decorateRequest` cost trade-off, and the
module-augmentation pattern that makes decorated properties show up in
TypeScript intellisense.

---

## Graceful shutdown

Express convention is to wire nothing: when the orchestrator
(Kubernetes, systemd, PM2, ECS, Fly, …) sends `SIGTERM`, the Node
process dies on the spot. In-flight requests are killed mid-write,
keep-alive sockets are dropped without `Connection: close`, and DB pools
never get a chance to flush. Most production Express apps quietly leak
five-nines availability this way.

RiftExpress ships a tiny helper you call once after `listen()`:

```ts
import { riftex, gracefulShutdown } from 'riftexpress'

const app = riftex()
// ... routes ...
const server = await app.listen(3000)

gracefulShutdown(server, {
  onShutdown: async () => {
    await db.end()      // close pools, flush logs, drain queues
  },
})
```

On `SIGTERM` / `SIGINT` the helper:

1. Stops accepting new connections (`server.close()`).
2. Awaits your `onShutdown` hook.
3. Waits up to `gracefulTimeoutMs` (default **10_000 ms**, matching
   Kubernetes' default `terminationGracePeriodSeconds` headroom) for
   in-flight requests and idle keep-alive sockets to finish naturally.
4. Force-destroys any sockets still open after the timeout.
5. Calls `process.exit(0)`.

If a second `SIGTERM` arrives during step 2–4 (impatient operator,
double Ctrl+C), the helper bails immediately with `process.exit(1)`.

Options:

| Option              | Default                    | Notes                                                     |
| ------------------- | -------------------------- | --------------------------------------------------------- |
| `gracefulTimeoutMs` | `10_000`                   | Hard cap before sockets are destroyed.                    |
| `signals`           | `['SIGTERM', 'SIGINT']`    | Any `NodeJS.Signals[]`.                                   |
| `onShutdown`        | `undefined`                | Awaited cleanup hook. Throwing exits with code 1.         |
| `logger`            | `console.log`              | Lifecycle messages.                                       |

The helper returns an unsubscribe function (`() => void`) that removes
the signal listeners — useful in tests and in apps that hot-reload.

Need to drain the server programmatically (without a signal)? Call
`server.close({ gracefulTimeoutMs: 5_000 })` directly — same draining
semantics, no signal handlers attached.
