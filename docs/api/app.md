# `RiftexApp` and the `riftex()` factory

The application object: registration journal, dispatch loop, transport binding, plugin host. Everything an app does at runtime — middleware composition, route lookup, error handling, request pooling — lives on a single `RiftexApp` instance.

## `riftex(options?)` — the factory

```ts
import { riftex } from 'riftexpress'

const app = riftex({ poolSize: 1024, trustProxy: false })
```

`riftex` is a function with static helpers attached. Calling it constructs and returns a new `RiftexApp`. Static properties:

| Property | Description |
|---|---|
| `riftex.Router()` | Construct a mountable `Router` (see [routing.md](./routing.md)). |
| `riftex.json(opts?)` | Express-compat body-parser stub (no-op; parsing is lazy via `ctx.body.json()`). |
| `riftex.urlencoded(opts?)` | Same, for `application/x-www-form-urlencoded`. |
| `riftex.static(root, opts?)` | Static-file middleware (see [middleware.md](./middleware.md)). |
| `riftex.cors(opts?)` | CORS middleware. |
| `riftex.sse(ctx)` | Open a Server-Sent Events stream on a context. |
| `riftex.rateLimit(opts?)` | Fixed-window rate-limit middleware. |

`riftex` is also the default export.

## `RiftexAppOptions`

```ts
interface RiftexAppOptions {
  poolSize?: number
  transport?: Transport
  trustProxy?: TrustProxy
}
```

| Field | Default | Notes |
|---|---|---|
| `poolSize` | `1024` | Max number of pooled `RiftexContext` instances kept on the free list. Excess contexts are released back to the GC. |
| `transport` | `new NodeAdapter()` | Inject a custom transport — `BunAdapter`, `Http2Adapter`, `Http2cAdapter`, or your own implementation of `Transport`. |
| `trustProxy` | `false` | Controls how `X-Forwarded-*` headers are honored when computing `ctx.ip`, `ctx.protocol`, `ctx.hostname`. See [the trust-proxy section in the README](../../README.md#trust-proxy) for the full type and per-value semantics. |

## `RiftexApp`

Construct directly with `new RiftexApp(options?)` or via `riftex(options?)`. Both produce equivalent instances.

### Registration

#### `app.use(mw)` / `app.use(prefix, mw | router)`

```ts
app.use(mw: RiftexMiddleware): this
app.use(prefix: string, mw: RiftexMiddleware | Router): this
```

Append global middleware, prefix-scoped middleware, or a mounted sub-router. Mount prefixes are normalized (`'/api/'` → `'/api'`, `''` and `'/'` mean "no prefix"). Throws `TypeError` if the second argument is neither a function nor a `Router`. Sets the dirty bit so the next request recomposes.

```ts
app.use(loggerMw)                        // every request
app.use('/admin', requireAdmin)          // /admin/*
app.use('/api/v1', v1Router)             // mounted router
```

#### Method helpers

```ts
app.get(path: string, handler: RiftexHandler): this
app.post(path: string, handler: RiftexHandler): this
app.put(path: string, handler: RiftexHandler): this
app.patch(path: string, handler: RiftexHandler): this
app.delete(path: string, handler: RiftexHandler): this
app.head(path: string, handler: RiftexHandler): this
app.options(path: string, handler: RiftexHandler): this
app.method(method: HttpMethod, path: string, handler: RiftexHandler): this
```

`app.method(...)` is the underlying primitive — the named helpers all delegate to it. Useful for registering routes whose method is determined at runtime.

```ts
app.get('/users/:id', (ctx) => loadUser(ctx.params.id))
app.method('OPTIONS', '/anywhere', () => ({ ok: true }))
```

#### `app.onError(handler)`

```ts
app.onError(handler: (err: unknown, ctx: RiftexContext) => unknown | Promise<unknown>): this
```

Register the global error handler. Re-throwing from the handler delegates to the default boundary (which serializes any `RiftexError` as `{ error, code, fields? }` with the right status — see [errors.md](./errors.md)).

```ts
app.onError((err, ctx) => {
  if (err instanceof RiftexValidationError) {
    return ctx.json({ error: err.message, fields: err.fields }, 422)
  }
  throw err  // delegate
})
```

### Plugin system

#### `app.register(plugin, opts?)`

```ts
register<O>(plugin: RiftexPlugin<O>, opts: O): Promise<this>
register(plugin: RiftexPlugin<void>): Promise<this>
```

Invoke a plugin against the app. Plugins are functions of shape `(app, opts) => void | Promise<void>`. Always `await` the call — plugins may be async. Sets the dirty bit so the next request recomposes.

```ts
const auth: RiftexPlugin<{ secret: string }> = (app, opts) => {
  app.decorate('user', (ctx) => verifyToken(ctx.headers.authorization, opts.secret))
}
await app.register(auth, { secret: process.env.JWT_SECRET! })
```

#### `app.decorate(name, factory)` — lazy

```ts
decorate<T>(name: string, factory: (ctx: RiftexContext) => T): this
```

Add a property to every `RiftexContext` that's computed the first time it's read and cached on the context for the rest of the request (self-replacing getter via `Object.defineProperty`). Use for expensive values that not every handler needs.

#### `app.decorateRequest(name, factory)` — eager

```ts
decorateRequest<T>(name: string, factory: (ctx: RiftexContext) => T): this
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
handle(ctx: RiftexContext): Promise<void>
```

Dispatch a single context through the framework. Used by transports — you usually do not call it directly except in tests or when wiring a custom transport. Handles route lookup, 404/405 generation (with the `Allow` header on 405), the fallback chain for path-mounted middleware (`riftex.static`), and the error boundary.

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

## `RiftexErrorHandler`

```ts
type RiftexErrorHandler = (err: unknown, ctx: RiftexContext) => unknown | Promise<unknown>
```

Signature for `app.onError(...)`. Return value is ignored — write the response by calling a `ctx` writer. Throwing (or re-throwing the original error) delegates to the default boundary.
