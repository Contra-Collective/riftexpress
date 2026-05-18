# `IngeniumApp` and the `ingenium()` factory

The application object: registration journal, dispatch loop, transport binding, plugin host. Everything an app does at runtime — middleware composition, route lookup, error handling, request pooling — lives on a single `IngeniumApp` instance.

## `ingenium(options?)` — the factory

```ts
import { ingenium } from 'ingenium'

const app = ingenium({ poolSize: 1024, trustProxy: false })
```

`ingenium` is a function with static helpers attached. Calling it constructs and returns a new `IngeniumApp`. Static properties:

| Property | Description |
|---|---|
| `ingenium.Router()` | Construct a mountable `Router` (see [routing.md](./routing.md)). |
| `ingenium.json(opts?)` | Express-compat body-parser stub (no-op; parsing is lazy via `ctx.body.json()`). |
| `ingenium.urlencoded(opts?)` | Same, for `application/x-www-form-urlencoded`. |
| `ingenium.static(root, opts?)` | Static-file middleware (see [middleware.md](./middleware.md)). |
| `ingenium.cors(opts?)` | CORS middleware. |
| `ingenium.sse(ctx)` | Open a Server-Sent Events stream on a context. |
| `ingenium.rateLimit(opts?)` | Fixed-window rate-limit middleware. |

`ingenium` is also the default export.

## `IngeniumAppOptions`

```ts
interface IngeniumAppOptions {
  poolSize?: number
  transport?: Transport
  trustProxy?: TrustProxy
}
```

| Field | Default | Notes |
|---|---|---|
| `poolSize` | `1024` | Max number of pooled `IngeniumContext` instances kept on the free list. Excess contexts are released back to the GC. |
| `transport` | `new NodeAdapter()` | Inject a custom transport — `BunAdapter`, `Http2Adapter`, `Http2cAdapter`, or your own implementation of `Transport`. |
| `trustProxy` | `false` | Controls how `X-Forwarded-*` headers are honored when computing `ctx.ip`, `ctx.protocol`, `ctx.hostname`. See [the trust-proxy section in the README](../../README.md#trust-proxy) for the full type and per-value semantics. |

## `IngeniumApp`

Construct directly with `new IngeniumApp(options?)` or via `ingenium(options?)`. Both produce equivalent instances.

### Registration

#### `app.use(mw)` / `app.use(prefix, mw | router)`

```ts
app.use(mw: IngeniumMiddleware): this
app.use(prefix: string, mw: IngeniumMiddleware | Router): this
```

Append global middleware, prefix-scoped middleware, or a mounted sub-router. Mount prefixes are normalized (`'/api/'` → `'/api'`, `''` and `'/'` mean "no prefix"). Throws `TypeError` if the second argument is neither a function nor a `Router`. Sets the dirty bit so the next request recomposes.

```ts
app.use(loggerMw)                        // every request
app.use('/admin', requireAdmin)          // /admin/*
app.use('/api/v1', v1Router)             // mounted router
```

#### Method helpers

```ts
app.get(path: string, handler: IngeniumHandler): this
app.post(path: string, handler: IngeniumHandler): this
app.put(path: string, handler: IngeniumHandler): this
app.patch(path: string, handler: IngeniumHandler): this
app.delete(path: string, handler: IngeniumHandler): this
app.head(path: string, handler: IngeniumHandler): this
app.options(path: string, handler: IngeniumHandler): this
app.method(method: HttpMethod, path: string, handler: IngeniumHandler): this
```

`app.method(...)` is the underlying primitive — the named helpers all delegate to it. Useful for registering routes whose method is determined at runtime.

```ts
app.get('/users/:id', (ctx) => loadUser(ctx.params.id))
app.method('OPTIONS', '/anywhere', () => ({ ok: true }))
```

#### `app.onError(handler)`

```ts
app.onError(handler: (err: unknown, ctx: IngeniumContext) => unknown | Promise<unknown>): this
```

Register the global error handler. Re-throwing from the handler delegates to the default boundary (which serializes any `IngeniumError` as `{ error, code, fields? }` with the right status — see [errors.md](./errors.md)).

```ts
app.onError((err, ctx) => {
  if (err instanceof IngeniumValidationError) {
    return ctx.json({ error: err.message, fields: err.fields }, 422)
  }
  throw err  // delegate
})
```

### Plugin system

#### `app.register(plugin, opts?)`

```ts
register<O>(plugin: IngeniumPlugin<O>, opts: O): Promise<this>
register(plugin: IngeniumPlugin<void>): Promise<this>
```

Invoke a plugin against the app. Plugins are functions of shape `(app, opts) => void | Promise<void>`. Always `await` the call — plugins may be async. Sets the dirty bit so the next request recomposes.

```ts
const auth: IngeniumPlugin<{ secret: string }> = (app, opts) => {
  app.decorate('user', (ctx) => verifyToken(ctx.headers.authorization, opts.secret))
}
await app.register(auth, { secret: process.env.JWT_SECRET! })
```

#### `app.decorate(name, factory)` — lazy

```ts
decorate<T>(name: string, factory: (ctx: IngeniumContext) => T): this
```

Add a property to every `IngeniumContext` that's computed the first time it's read and cached on the context for the rest of the request (self-replacing getter via `Object.defineProperty`). Use for expensive values that not every handler needs.

#### `app.decorateRequest(name, factory)` — eager

```ts
decorateRequest<T>(name: string, factory: (ctx: IngeniumContext) => T): this
```

Add a property that's computed at the start of every request and assigned directly. Use for cheap values nearly every handler reads (request id, start timestamp).

#### `app.hooks`

```ts
get hooks(): Hooks
```

Read-only handle to the lifecycle hooks registry. Plugins call `app.hooks.onRequest(fn)`, `app.hooks.onResponse(fn)`, `app.hooks.onError(fn)`, `app.hooks.onRoute(fn)`, `app.hooks.onCompose(fn)` to subscribe. Order: `onCompose` (once, before first request) → `onRoute` (per route, during compose) → per request: `onRequest` → decorators → middleware/handler → `onResponse` (success only) or `onError` (throw only — observation; the boundary still owns the response).

### Composition and dispatch

#### `app.compose()`

```ts
compose(): void
```

Synchronously walk the registration journal and rebuild the trie with composed handlers at every leaf. Auto-runs on the first request (or after any registration that flips the dirty bit). Call explicitly to pre-warm before traffic hits.

`compose()` skips `onCompose` hooks because those may be async — `handle()` and `listen()` use an internal async path that awaits them. Calling `compose()` directly is for pre-warm only; for hook-aware composition just await `app.handle(...)` once or rely on `app.listen()`.

#### `app.handle(ctx)`

```ts
handle(ctx: IngeniumContext): Promise<void>
```

Dispatch a single context through the framework. Used by transports — you usually do not call it directly except in tests or when wiring a custom transport. Handles route lookup, 404/405 generation (with the `Allow` header on 405), the fallback chain for path-mounted middleware (`ingenium.static`), and the error boundary.

#### `app.listen(port, host?)`

```ts
listen(port: number, host?: string): Promise<ListeningServer>
```

Bind a port via the configured transport and start accepting requests. Returns a handle exposing `port`, `host`, and `close({ gracefulTimeoutMs? })`. Defaults for `host` are transport-specific (`NodeAdapter` and `Http2*Adapter` default to `'127.0.0.1'`). Composes lazily before binding if dirty.

```ts
const server = await app.listen(3000)
console.log(`listening on ${server.host}:${server.port}`)
await server.close({ gracefulTimeoutMs: 10_000 })
```

For SIGTERM-driven shutdown, wire `gracefulShutdown(server, opts)` after — see [transports.md](./transports.md#gracefulshutdown).

Calling `app.listen()` twice on the same app throws `TypeError("app.listen(): this app is already listening...")`. Close the existing server (`server.close()`) before re-listening, or create a separate app.

#### `app.inject(req)` — in-process test client

```ts
interface InjectRequest {
  method?: HttpMethod          // defaults to 'GET'
  url: string                  // includes query string, e.g. '/users/42?expand=posts'
  headers?: Record<string, string | string[]>   // keys lowercased before assignment
  body?: string | Buffer | Uint8Array | object  // object → JSON-stringified + auto content-type
  remoteAddress?: string       // defaults to '127.0.0.1'
}

interface InjectResponse {
  status: number
  headers: Record<string, string | string[]>
  body: string                 // UTF-8; streams drained; buffers decoded
  json<T = unknown>(): T       // JSON.parse(body)
}

inject(req: InjectRequest): Promise<InjectResponse>
```

Dispatch a synthetic request through the framework WITHOUT binding a port or going through the transport layer. Returns the response state captured directly from the pooled context — ~10× faster than spinning an ephemeral port per test, while exercising the same dispatch path (middleware, hooks, decorators, the trie, the error boundary).

```ts
const res = await app.inject({
  method: 'POST',
  url: '/users',
  body: { name: 'Ada' },
})
expect(res.status).toBe(201)
expect(res.json()).toEqual({ id: 1, name: 'Ada' })
```

Body normalization: a plain object/array gets `JSON.stringify`'d and `content-type: application/json` auto-set (unless the caller already set one). String → UTF-8 buffer; `Buffer`/`Uint8Array` → verbatim. Anything else throws `TypeError` at call time. Each `inject()` acquires from and releases to the same context pool the wire path uses — sequential calls are correctly isolated.

#### `app.scope(prefix, register)` — plugin scoping

```ts
scope(prefix: string, register: (scope: ScopedApp) => void | Promise<void>): this
```

Mount middleware, plugins, and routes onto a path subtree. The registrar receives a `ScopedApp` — a facade implementing `PluginTarget` that translates every `use(mw)` / `get(path, h)` / `register(plugin)` call into a prefix-relative registration on the root app. Compose-time resolution: the hot path is unchanged.

```ts
app.scope('/api/v2', (scope) => {
  scope.use(requireAuth)                  // applies only under /api/v2
  scope.register(metricsPlugin)           // plugin's target.use/get are prefix-relative
  scope.get('/users', listUsers)          // → /api/v2/users
  scope.scope('/admin', (admin) => {      // nested → /api/v2/admin/...
    admin.use(requireAdminRole)
    admin.delete('/users/:id', deleteUser)
  })
})
```

`ScopedApp` surface: `use`, `get/post/put/patch/delete/head/options/method`, `register`, `before`, `after`, `scope`, `decorate`/`decorateRequest` (with a dev warning — see below), and `hooks` (read-only; hooks are global by design). It does NOT expose `compose`, `handle`, `listen`, `onError`, `queue`, `cron`, or `describe` — those stay on the root app.

**Decorator caveat.** `scope.decorate(name, factory)` registers the decorator GLOBALLY (it applies to every context, regardless of scope) and emits a one-shot `process.emitWarning` in dev mode. The reason: lazy decorators install on the pooled context at request start, before the route is matched, so per-scope decorators would force a runtime path check on every property access. If you need scope-aware behavior, either path-check inside the decorator's resolver (`if (ctx.path.startsWith('/api/v2')) ...`) or use a scoped middleware (`scope.use(mw)`) instead.

## `IngeniumErrorHandler`

```ts
type IngeniumErrorHandler = (err: unknown, ctx: IngeniumContext) => unknown | Promise<unknown>
```

Signature for `app.onError(...)`. Return value is ignored — write the response by calling a `ctx` writer. Throwing (or re-throwing the original error) delegates to the default boundary.
