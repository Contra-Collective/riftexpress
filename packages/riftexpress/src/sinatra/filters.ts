/**
 * Sinatra-style `before` / `after` filters.
 *
 * `before(pattern?, handler)` runs BEFORE the route handler. Equivalent to
 *   app.use(prefix, mw)  // when pattern is given
 *   app.use(mw)          // when pattern is omitted
 * The user writes only the body of the filter — the wrapper invokes
 * `await next()` automatically. If the filter calls a response writer
 * (`ctx.json`, `ctx.text`, ...) the chain short-circuits because `next()`
 * is never called, so the route handler does not run.
 *
 * `after(pattern?, handler)` runs AFTER the route handler resolves but
 * BEFORE the adapter writes to the wire. The wrapper calls `await next()`
 * first and then runs the user filter, so the filter can observe the final
 * response state on `ctx`.
 *
 * Pattern semantics in v0.0.1:
 *   - Simple boundary-respecting prefix match (reuses the same
 *     `pathStartsWith` rule the app uses for scoped middleware).
 *   - `'/admin/*'` and `'/admin'` both match `/admin` and `/admin/users`
 *     but neither matches `/administrator`. The trailing `/*` is sugar
 *     and is stripped before matching.
 *   - Regex patterns and trailing-slash flexibility are out of scope.
 */

import type { RiftexMiddleware } from '../middleware/types.ts'
import type { RiftexApp } from '../app.ts'

/**
 * Strip the Sinatra-style trailing `/*` (or bare `*`) from a prefix so that
 * `/admin/*` and `/admin` both reduce to `/admin` for prefix matching.
 * A bare `*` (or `/*`) means "every path" → empty prefix.
 */
function normalizeFilterPattern(pattern: string): string {
  if (pattern === '*' || pattern === '/*' || pattern === '/') return ''
  if (pattern.endsWith('/*')) return pattern.slice(0, -2)
  if (pattern.endsWith('*')) return pattern.slice(0, -1)
  return pattern
}

/**
 * Wrap a user `before` filter so it auto-calls `next()` after its body runs.
 * If the filter throws, the error propagates to the framework error boundary.
 * If the filter writes a response (and never calls `next()`), it
 * short-circuits — but since the wrapper IS the one that calls `next()`, we
 * detect short-circuit by checking `ctx._written` after the user filter
 * resolves and skip the downstream chain in that case.
 */
function wrapBefore(handler: RiftexMiddleware): RiftexMiddleware {
  return async (ctx, next) => {
    // The handler may receive a no-op `next` of its own — but for ergonomic
    // Sinatra parity we want it to look handler-shaped (just `(ctx) => ...`).
    // We pass a `noopNext` and inspect ctx._written afterward to decide
    // whether to invoke the real downstream chain.
    const noopNext = async (): Promise<void> => {}
    await handler(ctx, noopNext)
    // Short-circuit if the filter wrote a response — don't run the route.
    if ((ctx as unknown as { _written?: boolean })._written) return
    await next()
  }
}

/**
 * Wrap a user `after` filter so it runs only AFTER the downstream chain
 * resolves. The filter sees the final response state on `ctx` (status code,
 * headers, body buffer). Errors thrown by the filter propagate to the
 * framework error boundary just like errors from any other middleware.
 */
function wrapAfter(handler: RiftexMiddleware): RiftexMiddleware {
  return async (ctx, next) => {
    await next()
    const noopNext = async (): Promise<void> => {}
    await handler(ctx, noopNext)
  }
}

/**
 * Register a `before` filter on `app`. If `pattern` is omitted, the filter
 * is registered as a global middleware (runs for every request). Otherwise
 * the pattern is normalized and registered as a path-scoped middleware.
 */
export function registerBefore(
  app: RiftexApp,
  patternOrHandler: string | RiftexMiddleware,
  maybeHandler?: RiftexMiddleware,
): RiftexApp {
  if (typeof patternOrHandler === 'function') {
    app.use(wrapBefore(patternOrHandler))
    return app
  }
  if (typeof maybeHandler !== 'function') {
    throw new TypeError('before(pattern, handler): handler must be a function')
  }
  const prefix = normalizeFilterPattern(patternOrHandler)
  if (prefix === '') {
    app.use(wrapBefore(maybeHandler))
  } else {
    app.use(prefix, wrapBefore(maybeHandler))
  }
  return app
}

/**
 * Register an `after` filter on `app`. Same pattern semantics as
 * `registerBefore`, but the user body runs after the downstream chain.
 */
export function registerAfter(
  app: RiftexApp,
  patternOrHandler: string | RiftexMiddleware,
  maybeHandler?: RiftexMiddleware,
): RiftexApp {
  if (typeof patternOrHandler === 'function') {
    app.use(wrapAfter(patternOrHandler))
    return app
  }
  if (typeof maybeHandler !== 'function') {
    throw new TypeError('after(pattern, handler): handler must be a function')
  }
  const prefix = normalizeFilterPattern(patternOrHandler)
  if (prefix === '') {
    app.use(wrapAfter(maybeHandler))
  } else {
    app.use(prefix, wrapAfter(maybeHandler))
  }
  return app
}

/** @internal Exposed for tests. */
export const _internal_normalizeFilterPattern = normalizeFilterPattern
