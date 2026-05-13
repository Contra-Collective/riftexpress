# `RiftexContext`

The per-request object passed to every middleware and handler. Pool-bound: one instance per pool slot, reused across thousands of requests. All mutable fields are reset between uses; the reset is a sequence of reassignments to keep the V8 hidden class stable so subsequent allocations stay monomorphic.

```ts
class RiftexContext<Params = Record<string, string>>
```

`Params` is a phantom generic — narrowing `ctx.params` for typed handlers — that's `Record<string, string>` at runtime.

---

## Request fields

### `method: HttpMethod`

Uppercase HTTP method. One of `'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'`.

### `url: string`

The full request URL the client sent — path plus `?query`. Defaults to `'/'`.

### `path: string`

The path portion of `url`, no query string. Defaults to `'/'`. Set by the adapter.

### `rawQuery: string`

Raw query string with no leading `?`. Defaults to `''`. Use this when you want the original encoding rather than parsed pairs.

### `query: URLSearchParams`

Lazy-parsed view of `rawQuery`. The first read constructs a `URLSearchParams`; subsequent reads return the cached instance. Use `.get(name)`, `.getAll(name)`, `.has(name)`, iteration, etc.

```ts
app.get('/search', (ctx) => ({
  q: ctx.query.get('q'),
  tags: ctx.query.getAll('tag'),
}))
```

### `params: Params`

Route params written at trie-match time. Defaults to a frozen sentinel `EMPTY_PARAMS` so `ctx.params.foo` is safe even on routes with no params. When `Params` is supplied (via `RiftexHandler<P>` or by typing the handler signature), TypeScript narrows it.

### `headers: IncomingHttpHeaders`

Lowercased request headers, per Node's `node:http` convention. Values are `string | string[] | undefined`. Defaults to `{}`.

### `body: RiftexBody`

Lazy body accessor. See [body.md](./body.md) for `json`, `text`, `urlencoded`, `buffer`, `stream`, `multipart`. The adapter attaches the raw stream to `ctx.body` on every request; nothing is read until you call a parser.

### `state: Record<string, unknown>`

Per-request scratch space for plugins and middleware. Initialized to a fresh `Object.create(null)` on every reset. Stash anything you want here — request id, current user, decoded JWT — and read it from later middleware. Module augmentation lets you type it more strictly if you prefer.

---

## Network info

All four of `ip`, `ips`, `protocol`, `hostname` are trust-proxy aware. With `trustProxy: false` (the default) they reflect the immediate socket peer; with trust-proxy enabled the `X-Forwarded-*` chain is walked according to the configured policy. Resolution is lazy and cached on first read.

### `remoteAddress: string`

Immediate socket peer address. Always the raw socket value, never XFF-derived. Defaults to `'127.0.0.1'`.

### `baseProtocol: 'http' | 'https'`

The underlying transport's protocol — `http` for `node:http`, `https` for TLS, `http` for h2c, `https` for h2/TLS. Set by the adapter. This is what `protocol` falls back to when there is no `X-Forwarded-Proto` (or the proxy isn't trusted).

### `ip: string` (getter)

Best-effort client IP. With `trustProxy: false` returns `remoteAddress`. With trust-proxy enabled, walks the `X-Forwarded-For` chain right-to-left and returns the first untrusted entry. See the trust-proxy table in the [README](../../README.md#trust-proxy).

### `ips: readonly string[]` (getter)

The full forwarded chain, left-to-right (closest to client first), with the immediate socket peer appended at the end. Always has at least one entry.

### `protocol: 'http' | 'https'` (getter)

Honors `X-Forwarded-Proto` when trust-proxy is enabled. Otherwise returns `baseProtocol`.

### `secure: boolean` (getter)

Convenience: `protocol === 'https'`.

### `hostname: string` (getter)

Honors `X-Forwarded-Host` when trust-proxy is enabled, else parses the `Host` request header (port stripped, IPv6 brackets handled). Falls back to `'localhost'` when no host header is present.

---

## Response setters

All setters are chainable (return `this`).

### `status(code: number): this`

Set the HTTP status code. Does not write the response by itself; pair with a writer or with a value-returning handler.

```ts
ctx.status(201).set('x-trace-id', id)
```

### `set(name: string, value: string | string[]): this`

Set a response header. Header names are stored lowercased internally for case-insensitive lookup.

### `setHeader(name: string, value: string | string[]): this`

Alias for `set`. Matches Express's `res.setHeader`.

### `getHeader(name: string): string | string[] | undefined`

Read back a previously-set response header. Lookup is case-insensitive.

---

## Response writers

Calling any writer marks the context as written (`_written = true`); subsequent return values from the handler are ignored. Writers do not throw — invalid headers or stream errors are surfaced by the adapter when it flushes.

### `json(body: unknown, status?: number): void`

Serialize `body` with `JSON.stringify` and send with `Content-Type: application/json; charset=utf-8`. If `Content-Type` was already set by `set()`, it's preserved.

### `text(body: string, status?: number): void`

Send `body` with `Content-Type: text/plain; charset=utf-8` (preserved if already set).

### `html(body: string, status?: number): void`

Send `body` with `Content-Type: text/html; charset=utf-8` (preserved if already set).

### `send(body: Buffer | string, status?: number): void`

Generic writer. A `string` body sends `text/plain; charset=utf-8`; a `Buffer` body sends `application/octet-stream`. Existing `Content-Type` is preserved.

### `redirect(location: string, status?: number): void`

Set the `Location` header and the status (default `302`). Body is empty.

```ts
ctx.redirect('/login')                // 302
ctx.redirect('/v2/items', 301)        // 301
```

### `stream(readable: Readable, contentType?: string): void`

Pipe a `node:stream` `Readable` to the client. If `contentType` is provided and `Content-Type` isn't already set, it's stamped. Used internally by `riftex.sse` (which sets `text/event-stream`).

---

## Pool semantics

A `RiftexContextPool` (default `poolSize: 1024`) keeps a free list of `RiftexContext` instances. On every request the transport calls `acquire()` to pull one; on release the framework calls `reset()` to zero every field by reassignment, then returns it to the pool.

The reassignment style is intentional: it preserves the V8 hidden class so the next request finds the same shape. This is the difference between monomorphic and megamorphic property access — significant on a hot path that runs millions of times.

### `reset(): void` — internal

`RiftexContext.reset()` is `@internal`. The pool calls it; user code should not. Listed here for completeness:

- All request fields revert to defaults (`method: 'GET'`, `path: '/'`, `headers: {}`, `state: Object.create(null)`, etc.).
- The cached `_query` is dropped.
- The trust-proxy field reverts to `false` and the cached `_forwarded` resolution is cleared.
- Response state (`_statusCode`, `_headers`, `_body`, `_written`) resets to "fresh".
- `body._reset()` is called to clear the lazy body source.

If you reach into a context after release (don't), you'll see a fresh-looking instance.
