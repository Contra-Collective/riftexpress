# Transports

A transport binds the RiftExpress dispatch loop to a concrete server runtime — `node:http`, Bun's `Bun.serve()`, `node:http2`, or anything else that produces a request and accepts a response. The default is `NodeAdapter`; override via `riftex({ transport: ... })`.

## `Transport` interface

```ts
interface Transport {
  attach(hooks: TransportHooks): void
  listen(port: number, host?: string): Promise<ListeningServer>
}
```

`attach` is called once by `app.listen()` to wire framework-side hooks. `listen` binds a port and starts accepting requests.

## `TransportHooks`

```ts
interface TransportHooks {
  acquire: () => RiftexContext
  release: (ctx: RiftexContext) => void
  dispatch: (ctx: RiftexContext) => Promise<void>
}
```

A transport's per-request loop:

1. `const ctx = hooks.acquire()` — pull a context from the pool.
2. Populate `ctx` from the underlying request (method, url, path, rawQuery, headers, body source, remoteAddress, baseProtocol).
3. `await hooks.dispatch(ctx)` — let the framework run.
4. Write `ctx._statusCode`, `ctx._headers`, `ctx._body` to the wire.
5. `hooks.release(ctx)` — return to the pool (calls `reset()`).

Implement your own transport if you need a runtime adapter that doesn't ship with RiftExpress.

## `ListeningServer`

```ts
interface ListeningServer {
  port: number
  host: string
  close(opts?: CloseOptions): Promise<void>
}

interface CloseOptions {
  gracefulTimeoutMs?: number
}
```

`port` and `host` are the bound values (resolved if `port: 0` was passed). `close()` stops accepting new connections and resolves when in-flight requests finish. With `gracefulTimeoutMs`, idle keep-alive sockets still open after that many ms are forcibly destroyed; without it, `close()` waits indefinitely (matching Node's historical `server.close()` behavior).

---

## `NodeAdapter` — default

```ts
import { NodeAdapter } from 'riftexpress'
const app = riftex({ transport: new NodeAdapter() })  // explicit; usually omitted
```

Wraps `node:http`. No translation layer to WinterCG `Request`/`Response` — adapter writes straight from `IncomingMessage` to `RiftexContext`, and `RiftexContext` straight to `ServerResponse`. Default host: `'127.0.0.1'`.

---

## `BunAdapter` — `riftexpress-bun`

```ts
import { riftex } from 'riftexpress'
import { BunAdapter } from 'riftexpress-bun'

const app = riftex({ transport: new BunAdapter() })
await app.listen(3000)
```

Wraps `Bun.serve()`. The adapter bridges WinterCG `Request`/`Response` ↔ `node:stream` so existing `RiftexBody` parsers work unchanged. Lazy body — request body is not materialized unless `ctx.body.*` is called. Throws if the runtime is not Bun (`typeof Bun === 'undefined'`).

Default host: `'127.0.0.1'`.

---

## `Http2Adapter` — h2 (TLS)

```ts
import { Http2Adapter } from 'riftexpress'
import { readFileSync } from 'node:fs'

const app = riftex({
  transport: new Http2Adapter({
    cert: readFileSync('cert.pem'),
    key:  readFileSync('key.pem'),
    allowHttp1: true,    // ALPN fallback to HTTP/1.1 on the same port
  }),
})
await app.listen(443)
```

### `Http2AdapterOptions`

```ts
interface Http2AdapterOptions {
  cert: Buffer | string
  key: Buffer | string
  allowHttp1?: boolean   // default false (HTTP/2 only)
}
```

Built on `node:http2`'s `createSecureServer`. Browsers REQUIRE TLS for HTTP/2 — there is no cleartext HTTP/2 negotiation over the open web. With `allowHttp1: true`, HTTP/1.1 clients land on the `'request'` event and are dispatched through a parallel populate-and-write path (the framework can't reuse `NodeAdapter` directly because `Http2ServerRequest`/`Response` are subclasses, but the surface is identical so the duplication is small).

HTTP/2 pseudo-headers (`:method`, `:path`, `:status`, `:scheme`, `:authority`) are handled internally — user code reads regular headers. `Transfer-Encoding: chunked` is stripped from responses (HTTP/2 has implicit framing).

Default host: `'127.0.0.1'`.

---

## `Http2cAdapter` — h2c (cleartext)

```ts
import { Http2cAdapter } from 'riftexpress'

const app = riftex({ transport: new Http2cAdapter() })
await app.listen(3000)
```

Cleartext HTTP/2 via `node:http2`'s `createServer`. No TLS. Intended for local dev, internal service-to-service traffic behind an L7 proxy that handles TLS termination, or test suites — browsers do not speak h2c.

Constructor takes no required arguments. Default host: `'127.0.0.1'`.

---

## `WsNodeAdapter` — WebSocket-aware Node

```ts
import { riftex, enableWebSockets } from 'riftexpress'

const app = riftex()
enableWebSockets(app)             // monkey-patches app.ws / app.upgradeWith and swaps in WsNodeAdapter

app.ws('/echo', (sock) => {
  sock.on('message', (msg) => sock.send(msg))
})

await app.listen(3000)
```

`enableWebSockets(app)` installs the `WsNodeAdapter` (a `NodeAdapter` subclass that exposes the underlying `http.Server` to a per-app registrar) and adds two methods to the app via type augmentation:

- `app.ws(path, handler, options?)` — register a WebSocket route. Uses `ws`'s `WebSocketServer({ noServer: true })` and hooks the `upgrade` event. Unknown paths get the socket destroyed cleanly.
- `app.upgradeWith(integrator)` — hand the underlying `http.Server` to your own integrator (socket.io, custom upgrade handlers, etc.).

`enableWebSockets` is idempotent — calling more than once on the same app is a no-op. Requires the `ws` peer dependency (`npm install ws @types/ws`); if a custom transport was injected via `RiftexAppOptions.transport`, the swap is skipped and a warning is emitted (you're responsible for calling the registrar's `attach()` from your transport).

---

## `gracefulShutdown(server, opts?)`

```ts
import { gracefulShutdown } from 'riftexpress'

function gracefulShutdown(
  server: ListeningServer,
  opts?: ShutdownOptions,
): () => void

interface ShutdownOptions {
  gracefulTimeoutMs?: number          // default 10_000 (matches K8s terminationGracePeriodSeconds headroom)
  signals?: NodeJS.Signals[]          // default ['SIGTERM', 'SIGINT']
  onShutdown?: () => void | Promise<void>
  logger?: (msg: string) => void      // default console.log
}
```

Wire signal handlers that gracefully drain `server`. On the configured signals:

1. Stop accepting new connections (`server.close()`).
2. Await `onShutdown` (close DB pools, flush logs, drain queues).
3. Wait up to `gracefulTimeoutMs` for in-flight requests and idle keep-alive sockets to finish naturally.
4. Force-destroy any sockets still open after the timeout.
5. `process.exit(0)`.

A second signal during shutdown → immediate `process.exit(1)`. Returns an unsubscribe function (`() => void`) that removes the signal listeners — useful in tests and apps that hot-reload.

```ts
const server = await app.listen(3000)

gracefulShutdown(server, {
  gracefulTimeoutMs: 10_000,
  signals: ['SIGTERM', 'SIGINT'],
  onShutdown: async () => {
    await db.close()
    await queue.flush()
  },
})
```

Without graceful shutdown wired, your server dies immediately on SIGTERM and in-flight requests are dropped. Every production deployment needs this.
