/**
 * Sinatra-style top-level shorthand.
 *
 * Lets users skip the app object entirely:
 *
 * ```ts
 * import { get, post, listen } from 'riftexpress'
 *
 * get('/', () => 'hi')
 * get('/users/:id', (ctx) => ({ id: ctx.params.id }))
 * post('/echo', async (ctx) => ctx.body.json())
 *
 * await listen(3000)
 * ```
 *
 * All exported verbs route to a lazy singleton `RiftexApp` created on first
 * call. The instance is retained for the lifetime of the process; tests can
 * call `_resetDefaultApp()` to drop it (this throws in production).
 */

import { RiftexApp, type RiftexErrorHandler } from '../app.ts'
import type { RiftexHandler, RiftexMiddleware } from '../middleware/types.ts'
import { Router } from '../router/router.ts'
import type { ListeningServer } from '../transport/types.ts'

let _defaultApp: RiftexApp | null = null

/**
 * Get the lazy default app. Created on first call, retained for the
 * lifetime of the process (or until `_resetDefaultApp()` is invoked).
 *
 * The same instance is returned on every subsequent call, so all
 * top-level verb functions and `listen()` operate on a single coherent
 * registration journal.
 */
export function defaultApp(): RiftexApp {
  if (!_defaultApp) _defaultApp = new RiftexApp()
  return _defaultApp
}

/**
 * Reset the default app — for tests only. The next call to any top-level
 * function will lazily create a fresh `RiftexApp`. Throws when
 * `NODE_ENV === 'production'` so accidental production calls are loud.
 */
export function _resetDefaultApp(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('_resetDefaultApp is a test-only API')
  }
  _defaultApp = null
}

// ───── HTTP verb shorthand ──────────────────────────────────────────────────
//
// Signatures mirror `RiftexApp.get/post/...` exactly (`(path, handler)`),
// so the typed-ctx story (e.g. `RiftexHandler<{ id: string }>`) is preserved
// for users who import these as drop-in replacements for `app.get(...)`.

export function get(path: string, handler: RiftexHandler): RiftexApp {
  return defaultApp().get(path, handler)
}

export function post(path: string, handler: RiftexHandler): RiftexApp {
  return defaultApp().post(path, handler)
}

export function put(path: string, handler: RiftexHandler): RiftexApp {
  return defaultApp().put(path, handler)
}

export function patch(path: string, handler: RiftexHandler): RiftexApp {
  return defaultApp().patch(path, handler)
}

/**
 * Default-app shorthand for `app.delete(path, handler)`.
 * Exported as `del` because `delete` is a reserved word in JavaScript and
 * cannot be used as a top-level identifier. `index.ts` re-exports this as
 * `{ del as delete }` so the public name is `delete`.
 */
export function del(path: string, handler: RiftexHandler): RiftexApp {
  return defaultApp().delete(path, handler)
}

export function head(path: string, handler: RiftexHandler): RiftexApp {
  return defaultApp().head(path, handler)
}

export function options(path: string, handler: RiftexHandler): RiftexApp {
  return defaultApp().options(path, handler)
}

// ───── use / onError / listen ───────────────────────────────────────────────

/**
 * Mount middleware on the default app. Same overload set as `app.use`:
 *   - `use(mw)` — global
 *   - `use(prefix, mw | Router)` — prefix-scoped
 */
export function use(mw: RiftexMiddleware): RiftexApp
export function use(prefix: string, mw: RiftexMiddleware | Router): RiftexApp
export function use(
  arg1: string | RiftexMiddleware,
  arg2?: RiftexMiddleware | Router,
): RiftexApp {
  const app = defaultApp()
  if (typeof arg1 === 'string') {
    return app.use(arg1, arg2 as RiftexMiddleware | Router)
  }
  return app.use(arg1)
}

/** Default-app shorthand for `app.onError(handler)`. */
export function onError(handler: RiftexErrorHandler): RiftexApp {
  return defaultApp().onError(handler)
}

/**
 * Bind the default app to a port. Returns a `ListeningServer` whose
 * `.close()` shuts down the underlying transport. Pass `0` for an
 * ephemeral port (useful in tests).
 */
export function listen(port: number, host?: string): Promise<ListeningServer> {
  return host !== undefined ? defaultApp().listen(port, host) : defaultApp().listen(port)
}

// ───── Sinatra-style filter shorthand ───────────────────────────────────────
//
// Mirrors `RiftexApp.before/after` overloads exactly.

export function before(handler: RiftexMiddleware): RiftexApp
export function before(pattern: string, handler: RiftexMiddleware): RiftexApp
export function before(
  arg1: string | RiftexMiddleware,
  arg2?: RiftexMiddleware,
): RiftexApp {
  const app = defaultApp()
  if (typeof arg1 === 'string') return app.before(arg1, arg2 as RiftexMiddleware)
  return app.before(arg1)
}

export function after(handler: RiftexMiddleware): RiftexApp
export function after(pattern: string, handler: RiftexMiddleware): RiftexApp
export function after(
  arg1: string | RiftexMiddleware,
  arg2?: RiftexMiddleware,
): RiftexApp {
  const app = defaultApp()
  if (typeof arg1 === 'string') return app.after(arg1, arg2 as RiftexMiddleware)
  return app.after(arg1)
}
