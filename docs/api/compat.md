# `riftexpress-compat`

Shim that lets Express-style `(req, res, next)` middleware run inside a RiftExpress chain. Lives in [`packages/riftexpress-compat`](../../packages/riftexpress-compat).

## Install

```sh
npm install riftexpress riftexpress-compat
# plus whatever Express middleware you actually want:
npm install cors helmet cookie-parser
```

## API

```ts
import { expressCompat } from 'riftexpress-compat'

function expressCompat(middleware: ExpressMiddleware): RiftexMiddleware

type ExpressMiddleware = (req: any, res: any, next: (err?: unknown) => void) => void
```

`req` and `res` are typed as `any` on purpose — the shim objects do not implement the full `Request`/`Response` surface, and `any` lets cors/helmet/morgan/etc. accept them at the call site without `as never` gymnastics.

## Usage

```ts
import { riftex } from 'riftexpress'
import { expressCompat } from 'riftexpress-compat'
import cors from 'cors'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'

const app = riftex()
app.use(expressCompat(cors({ origin: 'https://app.example.com' })))
app.use(expressCompat(helmet()))
app.use(expressCompat(cookieParser()))
```

## Behavior

The shim wraps a `(req, res, next)` middleware so it can run inside a RiftExpress middleware chain:

- Constructs a `req` shim from the `RiftexContext` (method, url, headers, params, query, plus a `Readable` for the body) and a `res` shim that proxies header/status/body writes back to the context.
- Awaits the middleware:
  - If it writes the response (`res.json/send/end/writeHead`), the RiftExpress chain is short-circuited (`next()` is NOT called).
  - If it calls `next()` without writing, the RiftExpress chain continues.
  - If it calls `next(err)`, the wrapper rejects with that error so it flows to the global `onError` boundary.
- Mirrors any `req.*` mutations (e.g. `req.user` set by an auth middleware) back to `ctx.state` for downstream Riftex middleware.
- If the middleware never calls `next()` and never writes, the chain is treated as halted (no further middleware runs).

## Compatibility status

The supported / partial / unsupported matrix is validated end-to-end in [`packages/riftexpress-compat/test/e2e.test.ts`](../../packages/riftexpress-compat/test/e2e.test.ts). Headline notes:

- **Supported** — `cors`, `helmet`, `cookie-parser`, `passport.initialize`.
- **Partial** — `morgan` (logging works; `:response-time` token may be inaccurate), `passport.authenticate` (depends on session), `express-rate-limit` (works with `validate: false` and a custom `keyGenerator`).
- **Unsupported** — `compression` (needs `res.write`/`res.end` ownership the shim doesn't proxy — use a reverse proxy), `body-parser` (use native `ctx.body.json()` / `ctx.body.urlencoded()`), `express-session` (silently no-ops — use native `sessionMiddleware`), `multer` (owns the request stream — use native `ctx.body.multipart()`).

For the full per-middleware status with failure modes, see [`packages/riftexpress-compat/COMPATIBILITY.md`](../../packages/riftexpress-compat/COMPATIBILITY.md).

## When to use the shim vs a native equivalent

Reach for the shim when there's an established Express middleware whose feature set you'd rather not reimplement (cors, helmet, cookie-parser). Reach for the native API when:

- The Express middleware in question is on the unsupported list above.
- You want lazy body parsing (`ctx.body.json()` instead of `body-parser`).
- You want a typed `ctx.session` with secret rotation (native `sessionMiddleware`).
- You want streaming/multipart with bounded memory (native `ctx.body.multipart()`).

Performance-wise the shim is cheap but not free — every shimmed call constructs `req`/`res` proxy objects per request. Native middleware avoids this.
