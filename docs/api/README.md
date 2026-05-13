# API reference

This is the per-module reference for RiftExpress v0.0.1. The locked public surface — what code outside the framework is allowed to import — lives in [`API.md`](../../API.md) at the repo root. The pages here go deeper: every exported function, class, type, option, throw, and edge case, grounded in the source under [`packages/riftexpress/src`](../../packages/riftexpress/src).

If something in these pages disagrees with the actual source, the source wins — please open an issue.

## Modules

| Page | Covers |
|---|---|
| [app.md](./app.md) | `riftex()` factory, `RiftexApp`, options, `use`, method registration, hooks, decorators, `compose`, `handle`, `listen`, `register` |
| [routing.md](./routing.md) | `Router`, mount semantics, path syntax, precedence, `ExtractParams`, `HttpMethod`, `HTTP_METHODS` |
| [context.md](./context.md) | `RiftexContext` — request, network info, response setters and writers, pool semantics |
| [body.md](./body.md) | `RiftexBody` on `ctx.body` — `json`, `text`, `urlencoded`, `buffer`, `stream`, `multipart`, schema detection |
| [errors.md](./errors.md) | `RiftexError` and the per-status subclasses, default boundary, `app.onError` |
| [middleware.md](./middleware.md) | Built-in middleware — `riftex.json`, `riftex.urlencoded`, `riftex.static`, `riftex.cors`, `riftex.csrf`, `riftex.sse`, `riftex.rateLimit`, `sessionMiddleware` |
| [csrf.md](./csrf.md) | `riftex.csrf` middleware — cookie + session storage modes, token issuance, `RiftexCsrfError` |
| [transports.md](./transports.md) | `Transport` interface, `NodeAdapter`, `BunAdapter`, `Http2Adapter`, `Http2cAdapter`, `WsNodeAdapter`, `gracefulShutdown` |
| [cli.md](./cli.md) | `riftexpress-cli` — `riftex new`, flags, templates |
| [compat.md](./compat.md) | `expressCompat()` shim, status matrix pointer |
| [schema.md](./schema.md) | Standard Schema v1 integration, `isStandardSchema`, detection order |

## Conventions

- Every code block uses TypeScript fences. Import from `'riftexpress'` unless noted.
- Names follow the v0.0.1 rename: `riftex()` factory, `Riftex*` classes (`RiftexApp`, `RiftexContext`, `RiftexBody`, `RiftexError`, …), `riftex.*` static helpers (`riftex.json`, `riftex.cors`, `riftex.static`, `riftex.sse`, `riftex.rateLimit`).
- Anything marked `@internal` in the source is documented for context only — do not depend on it; semver does not apply.
