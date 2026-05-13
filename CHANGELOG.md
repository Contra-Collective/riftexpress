# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the project is in alpha (`0.x.y-alpha`), breaking changes may land in
minor (or even patch) releases — see `docs/roadmap.md` for the working list of
deferred items and likely-to-shift surfaces.

## [Unreleased]

### Added

- **CSRF protection.** Native `riftex.csrf(opts)` middleware (also exported as
  `csrfMiddleware`). Two storage modes:
  - `'cookie'` (default): double-submit cookie pattern with HMAC-SHA-256
    signing. Token written to a non-`HttpOnly` cookie on safe requests; client
    must echo via `X-CSRF-Token` (or `X-XSRF-Token` / `?_csrf=`) on unsafe
    requests. Verified with `crypto.timingSafeEqual`. Secret rotation supported.
  - `'session'`: synchronizer pattern. Token stored on `ctx.session.csrfToken`,
    requires `sessionMiddleware` to run first.
  - Failures throw `RiftexCsrfError` (HTTP 403, code `CSRF_FAILED`).
  - Token exposed via `ctx.csrfToken()` and `ctx.state.csrfToken` for embedding
    in HTML forms.
  - 23 unit tests across both modes, including timing-safe compare and rotation.

- **`docs/api/csrf.md`** — full CSRF reference (storage modes, options,
  failure mode, rotation, skip patterns, what CSRF does NOT replace).
- **`docs/deployment.md`** — production deployment guide (nginx, Caddy, CDN,
  Docker, k8s, env vars, graceful shutdown, observability, HTTPS, process
  managers, pre-flight checklist).
- **`CODE_OF_CONDUCT.md`** — Contributor Covenant v2.1 reference.

### Changed

- Renamed `makeRexFactory` → `makeRiftexFactory` and `rexCore` → `riftexCore`
  (caught by post-rename sweep — the word-boundary script missed
  mid-camelCase tokens).

### Fixed

- **Middleware now runs on trie misses.** `app.use(riftex.static(...))` and
  `app.use(corsMw)` patterns work correctly: when no route matches, a
  fallback chain composed of global + path-matching scoped middleware runs
  before the 404/405 surfaces. Previously a request to an unregistered
  path 404'd before any middleware fired.

## [0.1.0-alpha] - 2026-05-12

First publishable alpha. Locks the core surface described in `API.md` and adds
the production-grade middleware required for non-trivial deployments.

### Added

- **App + Router.** `riftex()` factory, `RiftexApp`, mountable `Router` with prefix
  composition, lazy middleware composition with a dirty-bit recompose, and
  `app.compose()` pre-warm.
- **Routing.** Radix-trie router with deterministic precedence
  (static > `:param` > `*wildcard`), optional params (`:id?`), wildcard tails
  (`*path`), typed param extraction via `ExtractParams<Path>`.
- **Context + body.** Pooled `RiftexContext`, lazy `URLSearchParams`, lazy
  `RiftexBody` parsers (`json`, `text`, `urlencoded`, `buffer`, `stream`,
  `multipart`). Body-parser default limit is **100,000 bytes** (matches
  Express's `body-parser` default).
- **Multipart.** Native `RiftexBody.multipart()` for `multipart/form-data` with
  per-file / per-field caps and an allow-list for MIME prefixes.
- **Validation.** First-class
  [Standard Schema v1](https://standardschema.dev) detection in
  `RiftexBody.json(schema)`, with fallbacks for Zod's `safeParse` and any
  `{ parse(input): T }` validator. Issues normalized into a
  `RiftexValidationError` with a `fields` map.
- **Response helpers.** `ctx.json/text/html/send/redirect/stream` plus
  return-value reflection (object → JSON, string → text/html, `Buffer` →
  octet-stream, `Readable` → stream, `undefined` → 204).
- **Errors.** `RiftexError` hierarchy
  (`RiftexNotFoundError`, `RiftexUnauthorizedError`, `RiftexMethodNotAllowedError`,
  `RiftexPayloadTooLargeError`, `RiftexValidationError`, `RiftexBadRequestError`)
  and an `app.onError(handler)` boundary that re-throws to delegate.
- **Plugins.** `app.register(plugin, opts?)`, lifecycle hooks (`onRoute`,
  `onCompose`, `onRequest`, `onResponse`, `onError`), `app.decorate(name, fn)`
  (lazy) and `app.decorateRequest(name, fn)` (eager). Hot path
  short-circuits when no plugins are registered.
- **Middleware (built-ins).**
  - `riftex.json(opts?)` / `riftex.urlencoded(opts?)` — Express-compat no-ops
    (parsing remains lazy via `ctx.body.*`).
  - `riftex.static(root, opts?)` — ETag, conditional GET, range requests, MIME
    detection, `index` / `extensions` / `dotfiles` / `maxAge` (ms).
  - `riftex.cors(opts?)` — simple + preflight CORS with origin allowlist /
    regex / function, `Vary: Origin`, credentials guard against `*`.
  - `sessionMiddleware` — HMAC-signed cookie sessions, key rotation,
    `regenerate()`, pluggable store (default in-process), rolling TTL.
  - `rateLimit` — fixed-window limiter with `X-RateLimit-*` headers,
    `Retry-After`, pluggable store.
  - `sse(ctx)` + `startKeepAlive` — Server-Sent Events stream helper.
- **Transports.**
  - `NodeAdapter` (default) — `node:http`, socket tracking for graceful
    close.
  - `Http2Adapter` — `h2` over TLS with optional ALPN HTTP/1.1 fallback.
  - `Http2cAdapter` — `h2c` cleartext for local / behind-proxy use.
  - `BunAdapter` (`riftexpress-bun`) — `Bun.serve()` with WinterCG ↔
    `node:stream` body bridge.
  - `WsNodeAdapter` (`riftexpress/ws`) — opt-in WebSocket support via the
    optional `ws` peer dep, exposed through `enableWebSockets(app)`.
- **Trust-proxy.** `RiftexAppOptions.trustProxy` mirroring Express's
  `app.set('trust proxy', ...)` semantics — booleans, hop counts, CIDRs,
  keywords (`loopback`, `linklocal`, `uniquelocal`), or a custom predicate.
  `ctx.ip`, `ctx.ips`, `ctx.protocol`, `ctx.hostname`, `ctx.secure` are
  populated from `X-Forwarded-*` according to the policy.
- **Graceful shutdown.** `gracefulShutdown(server, opts?)` wires SIGTERM /
  SIGINT to drain the server, run a user `onShutdown` hook, and force-close
  idle keep-alive sockets after `gracefulTimeoutMs` (default 10 s, matching
  Kubernetes' default `terminationGracePeriodSeconds` headroom).
- **Express compat shim** (`riftexpress-compat`). `expressCompat(mw)`
  proxies pure-function `(req, res, next)` middleware (cors, helmet,
  morgan, compression). Documented incompatibilities in
  `docs/migration-guide.md`.
- **CLI** (`riftexpress-cli`). `riftex new <name> [--bun|--minimal|--force]`
  scaffolds a project. `riftex routes` is reserved for v0.2.
- **CI.** GitHub Actions matrix on Node 20 / 22 / 24 across Ubuntu and
  Windows; typecheck + Vitest run on every push.
- **Architecture decision records.** `docs/adr/0001`–`0005` covering the
  radix-trie router, lazy composition with the dirty bit, return-value
  reflection, the context pool, and the compat-shim scope.

### Changed

- Body-parser default limit standardized to 100,000 bytes for `json` /
  `text` / `urlencoded` / `buffer` (was previously documented as 1 MiB
  for `buffer` — see `packages/riftexpress/src/context/body.ts`).

### Deprecated

- Nothing yet.

### Removed

- Nothing yet.

### Fixed

- N/A — first public alpha.

### Security

- `sessionMiddleware` uses HMAC-SHA-256, `timingSafeEqual` verification,
  and 144-bit random ids. Tampered cookies silently issue a fresh session
  (no error response) so this surface is not an oracle.
- `riftex.cors` rejects `credentials: true` combined with `origin: '*'` at
  construction time per the Fetch spec.
- `riftex.static` resolves paths under `root` and rejects traversal; the
  `dotfiles` policy defaults to `'ignore'`.
- Default rate-limit `keyGenerator` reads `X-Forwarded-For` directly —
  see the JSDoc warning. Production deployments behind a proxy must
  configure `trustProxy` or supply a custom `keyGenerator`.

[Unreleased]: https://github.com/riftexpress/riftexpress/compare/v0.1.0-alpha...HEAD
[0.1.0-alpha]: https://github.com/riftexpress/riftexpress/releases/tag/v0.1.0-alpha
