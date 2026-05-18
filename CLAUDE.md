# Ingenium — agent contributor guide

This file is read into the context of every agent working on this codebase. The goal is not to teach the framework — read `README.md` for that. The goal is to surface the load-bearing patterns that an agent will otherwise re-discover by breaking them.

## Architecture rules — DO NOT regress these

### The hot path is gated by `hasAny()` / `_useFastPath`

`IngeniumApp._recomputeDispatchFlags()` runs at every `compose()` and caches booleans (`_hasHooks`, `_hasDecorators`, `_hasTimeout`, `_hasTrustProxy`) that the per-request dispatch in `handle()` branches on. The fast path (`_useFastPath`) is taken when an app uses NONE of: plugins, decorators, request timeout, trust-proxy.

**Any new opt-in feature MUST follow this pattern**: add a boolean flag computed once at compose time, branch on the field load (not on `.hasAny()` / array scans) in the dispatch loop. Never add unconditional per-request work for a feature most apps don't use.

### The pool resets by reassignment, not mutation

`IngeniumContext.reset()` reassigns every field (`this.headers = {}`, `this.state = Object.create(null)`, etc.) instead of mutating in place. V8 keeps the hidden class stable across reuses only when the field shape doesn't change — adding `delete this.x` or `this.x = undefined` for a previously-assigned reference type can deopt the entire site.

**When you add a new field to `IngeniumContext`**: declare it as a class field with an initializer (so the constructor stamps the hidden class), and zero it via reassignment in `reset()`. Use a frozen empty sentinel (see `EMPTY_PARAMS`) for record-shaped fields that default to "empty."

### Composition is lazy with a dirty bit, not freeze-on-listen

`app.register()`, `app.use()`, every verb registration, and `app.scope()` set `this.dirty = true`. The trie + composed handlers are rebuilt on first request (or via explicit `app.compose()`). This means **tests can register routes after `listen()`** — don't add freeze-on-listen.

When you add a new registration surface (e.g. a new `app.foo(...)` that affects dispatch), set the dirty bit at the END of the method.

### Per-route metadata lives on the route entry, not in a side map

The `Registration` discriminated union in `router/router.ts` carries everything composed about a route. New per-route data (inline middleware, declarative options) goes on the entry; new global data goes on the app. Side maps drift.

### Async + AsyncLocalStorage for orphan detection

`withEpochGuard` in `app.ts` is the load-bearing mechanism that keeps a timed-out, orphaned handler from corrupting the next request bound to the same pooled context. It uses an `AsyncLocalStorage<number>` carried through every `await` plus a per-context `_epoch` counter. **If you wrap or replace `ctx.json/text/html/send/redirect/stream`, route through `withEpochGuard` so the orphan-detection survives.** See ADR 0004 for the full reasoning.

### `process.emitWarning` calls must be wrapped in try/catch

Worker contexts can throw on `emitWarning`. Every framework warning site wraps it. Match the existing pattern.

### Dev-mode diagnostics are gated by a module-scope `IS_DEV` constant

`const IS_DEV = process.env.NODE_ENV !== 'production'` — read once at module load. The check must be the FIRST statement in the diagnostic block so V8 sees `if (false) { ... }` in production builds and dead-code eliminates the body. **Don't** put the env check inside the diagnostic body, and don't re-read `process.env.NODE_ENV` per request.

## What lives where

```
packages/ingenium/src/
├── app.ts                 IngeniumApp class — dispatch, compose, listen, inject, scope
├── app/scope.ts           ScopedApp facade
├── context/
│   ├── context.ts         IngeniumContext, ctx.query, response helpers
│   ├── body.ts            IngeniumBody — lazy parsers + buffer-level cache
│   └── pool.ts            IngeniumContextPool
├── router/
│   ├── router.ts          Router class + registration journal + flattenRouter
│   ├── trie.ts            RouterTrie — matched at request time
│   └── types.ts           HttpMethod, ExtractParams<Path>
├── middleware/
│   ├── compose.ts         compose, composeWithHandler
│   └── types.ts           IngeniumMiddleware, IngeniumHandler<P>
├── plugin/
│   ├── types.ts           IngeniumPlugin, PluginTarget, hook types
│   ├── decorators.ts      DecoratorRegistry (lazy + eager)
│   └── hooks.ts           HooksRegistry
├── transport/             NodeAdapter, Http2/Http2cAdapter, shutdown helpers
├── proxy/trust.ts         resolveForwarded (XFF / Forwarded parsing)
├── negotiation/           accept, format, etag, fresh, json-etag
├── schema/standard.ts     Standard Schema v1 detector
├── response/reflect.ts    Return-value reflection (object → JSON, etc.)
├── errors.ts              IngeniumError hierarchy
└── util/safe-json.ts      Lenient JSON.stringify
```

## Conventions

- **TypeScript imports use `.ts` extension** (NodeNext module resolution). `import { X } from './foo.ts'`.
- **`@internal` JSDoc tag** marks fields/methods callers shouldn't touch. They may change without a SemVer bump.
- **JSDoc on public surface explains WHY, not WHAT.** The name + signature show what the function does; the JSDoc explains the trade-off, the failure mode, or the reason the obvious-looking alternative was rejected.
- **Errors extend `IngeniumError`** with a `code: UPPER_SNAKE_CASE` and an HTTP `statusCode`. The default boundary serializes them as `{ error, code, fields? }`.
- **Tests live in `packages/ingenium/test/`** with one file per concept. Use `vitest`'s `expectTypeOf` for type-level tests; pattern in `test/extract-params.test.ts`.
- **`process.emitWarning` is always wrapped in try/catch** because worker runtimes throw.

## Pitfalls

- **Adding a global decorator costs every request.** `ctx.queue` is registered as a lazy decorator at app construction — every app using it falls OFF the fast path. That's the correct semantics (you pay for what you use) but be aware before adding more constructor-time decorators.
- **`Router.use(prefix, mw)` makes the middleware path-scoped at compose time** via `flattenRouter`'s `scopedMiddleware`. The trie itself doesn't know about middleware — the composer attaches the chain at each leaf based on `pathStartsWith`. Don't try to attach middleware to trie nodes directly.
- **A `Promise.race` against a timeout doesn't cancel the handler.** JS can't cancel promises. The orphan keeps running; `withEpochGuard` defends against its late writes via ALS + epoch comparison. New timeout-shaped features must reuse this pattern.
- **Pool release happens AFTER response extraction** in `app.inject()`. Release bumps `_epoch` and clears `_body`/`_headers` — if you read them after release you get the next request's state (or empty). Same rule for any new test-client-style code.
- **`pathStartsWith` requires a boundary char.** `/api` must not match `/apiary`. Use the helper, don't inline `path.startsWith(prefix)`.

## What NOT to change without an ADR

- The trie matching algorithm (ADR 0001).
- The lazy-compose / dirty-bit model (ADR 0002).
- Handler return-value reflection (ADR 0003) — adding a new reflected type widens the API surface forever.
- The context pool (ADR 0004) — replacing reset-by-reassignment with anything else risks V8 deopts.
- The compat shim scope (ADR 0005) — keep the supported list small and document failure modes for the rest.

Open an ADR (`docs/adr/000X-name.md`) before any of these.

## When in doubt

- Run `npm run typecheck` and `npm test` before claiming a task is done.
- If you're adding per-request overhead, justify it in a comment with the bench impact.
- If you're adding a public type/export, add it to `packages/ingenium/src/index.ts`, `API.md`, and the appropriate doc in `docs/api/`.
- If you're adding a feature listed in `docs/roadmap.md`, move it from "deferred" to "shipped" in the same commit.
