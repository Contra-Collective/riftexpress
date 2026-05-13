import { RiftexContext } from './context/context.ts'
import { RiftexContextPool } from './context/pool.ts'
import {
  RiftexError,
  RiftexMethodNotAllowedError,
  RiftexNotFoundError,
} from './errors.ts'
import { composeWithHandler } from './middleware/compose.ts'
import type { RiftexHandler, RiftexMiddleware } from './middleware/types.ts'
import { DecoratorRegistry } from './plugin/decorators.ts'
import { HooksRegistry } from './plugin/hooks.ts'
import type {
  EagerDecorator,
  Hooks,
  LazyDecorator,
  RiftexPlugin,
} from './plugin/types.ts'
import { Router, flattenRouter } from './router/router.ts'
import { EMPTY_PARAMS, RouterTrie, type MatchMiss } from './router/trie.ts'
import type { HttpMethod } from './router/types.ts'
import { NodeAdapter } from './transport/node.ts'
import type { ListeningServer, Transport } from './transport/types.ts'

/** Options accepted by `riftex(...)` and `new RiftexApp(...)`. */
export interface RiftexAppOptions {
  /** Max number of pooled `RiftexContext` instances kept in the free list. Default 1024. */
  poolSize?: number
  /** Inject a custom transport (e.g. for tests). Default: `NodeAdapter`. */
  transport?: Transport
  /**
   * Trust-proxy configuration — controls whether `X-Forwarded-For`,
   * `X-Forwarded-Proto`, `X-Forwarded-Host` are honored when computing
   * `ctx.ip`, `ctx.protocol`, `ctx.hostname`. Mirrors Express's
   * `app.set('trust proxy', ...)` semantics. Default `false` (never trust).
   * See `proxy/trust.ts` for the full type. Set to `true` only when running
   * behind a reverse proxy you control.
   */
  trustProxy?: import('./proxy/trust.ts').TrustProxy
}

/** A user-supplied error handler. Return a non-error or call a `ctx` writer to recover. */
export type RiftexErrorHandler = (err: unknown, ctx: RiftexContext) => unknown | Promise<unknown>

/**
 * The RiftExpress application. Combines a `Router` (registration journal),
 * a `RouterTrie` (matched at request time), a context pool, and a
 * transport. Composition is lazy: the trie's composed handlers are built
 * on first request (or when `compose()` is called explicitly), and a dirty
 * bit triggers recomposition if registrations are added later.
 */
export class RiftexApp {
  private readonly pool: RiftexContextPool
  private readonly transport: Transport
  private readonly router: Router = new Router()
  private trie: RouterTrie = new RouterTrie()
  private dirty = true
  private errorHandler: RiftexErrorHandler | null = null
  private readonly _hooks: HooksRegistry = new HooksRegistry()
  private readonly _decorators: DecoratorRegistry = new DecoratorRegistry()
  /** @internal Carried onto each `RiftexContext` so its `ip`/`protocol`/`hostname` getters can resolve. */
  private readonly _trustProxy: import('./proxy/trust.ts').TrustProxy

  constructor(options: RiftexAppOptions = {}) {
    this.pool = new RiftexContextPool(options.poolSize ?? 1024)
    this.transport = options.transport ?? new NodeAdapter()
    this._trustProxy = options.trustProxy ?? false
  }

  // ───── Plugin system ────────────────────────────────────────────────────

  /** Lifecycle hooks API — plugins call `app.hooks.onRequest(...)` etc. */
  get hooks(): Hooks { return this._hooks }

  /**
   * Register a plugin. Plugins are invoked immediately and may be async;
   * callers should `await app.register(...)` if the plugin returns a Promise.
   * Plugins must be registered BEFORE `compose()` runs (i.e. before the
   * first request); registering a plugin sets the dirty bit so the next
   * request will recompose.
   */
  register<O>(plugin: RiftexPlugin<O>, opts: O): Promise<this>
  register(plugin: RiftexPlugin<void>): Promise<this>
  async register<O>(plugin: RiftexPlugin<O>, opts?: O): Promise<this> {
    await plugin(this, opts as O)
    this.dirty = true
    return this
  }

  /**
   * Add a lazy decorator. The factory is invoked the first time `ctx[name]`
   * is read; the result is cached on the context for the rest of the request.
   *
   * @example
   * app.decorate('user', async (ctx) => loadUser(ctx.headers.authorization))
   */
  decorate<T>(name: string, factory: LazyDecorator<T>): this {
    this._decorators.decorate(name, factory)
    return this
  }

  /**
   * Add an eager decorator. The factory runs at the start of every request,
   * and the value is assigned directly to the context.
   *
   * @example
   * app.decorateRequest('startedAt', () => Date.now())
   */
  decorateRequest<T>(name: string, factory: EagerDecorator<T>): this {
    this._decorators.decorateRequest(name, factory)
    return this
  }

  // ───── Registration (delegates to the inner Router) ─────────────────────

  use(mw: RiftexMiddleware): this
  use(prefix: string, mw: RiftexMiddleware | Router): this
  use(arg1: string | RiftexMiddleware, arg2?: RiftexMiddleware | Router): this {
    if (typeof arg1 === 'string') {
      // Overload preserved by passing both args verbatim.
      this.router.use(arg1, arg2 as RiftexMiddleware | Router)
    } else {
      this.router.use(arg1)
    }
    this.dirty = true
    return this
  }

  get(path: string, handler: RiftexHandler): this { return this.method('GET', path, handler) }
  post(path: string, handler: RiftexHandler): this { return this.method('POST', path, handler) }
  put(path: string, handler: RiftexHandler): this { return this.method('PUT', path, handler) }
  patch(path: string, handler: RiftexHandler): this { return this.method('PATCH', path, handler) }
  delete(path: string, handler: RiftexHandler): this { return this.method('DELETE', path, handler) }
  head(path: string, handler: RiftexHandler): this { return this.method('HEAD', path, handler) }
  options(path: string, handler: RiftexHandler): this { return this.method('OPTIONS', path, handler) }

  /** Register a route under any HTTP method. */
  method(method: HttpMethod, path: string, handler: RiftexHandler): this {
    this.router.method(method, path, handler)
    this.dirty = true
    return this
  }

  /** Register a global error handler. Re-throw to delegate to the default boundary. */
  onError(handler: RiftexErrorHandler): this {
    this.errorHandler = handler
    return this
  }

  // ───── Composition ───────────────────────────────────────────────────────

  /**
   * Walk the registration journal and rebuild the trie with composed
   * handlers at every leaf. Auto-runs on first request; safe to call
   * explicitly to pre-warm.
   */
  /** Cached flat registrations — used to build the on-miss fallback chain. */
  private _flat: ReturnType<typeof flattenRouter> | null = null

  compose(): void {
    // Note: this entry is synchronous. Async `onCompose` hooks are awaited
    // by `composeAsync()` (the path used by `handle()` and `listen()`).
    // Calling `compose()` directly skips `onCompose` — pre-warm only.
    const flat = flattenRouter(this.router)
    const trie = new RouterTrie()
    const hasOnRoute = this._hooks.hasOnRoute()

    for (const route of flat.routes) {
      const node = trie.insert(route.path)

      // Determine which middleware applies to this route's path.
      const applicable: RiftexMiddleware[] = [...flat.globalMiddleware]
      for (const scoped of flat.scopedMiddleware) {
        if (pathStartsWith(route.path, scoped.prefix)) {
          applicable.push(scoped.mw)
        }
      }

      const composed = composeWithHandler(applicable, route.handler)
      node.handlers[route.method] = composed

      if (hasOnRoute) {
        this._hooks.runOnRoute({ method: route.method, path: route.path })
      }
    }

    this.trie = trie
    this._flat = flat
    this.dirty = false
  }

  /**
   * Async composition entry — runs `onCompose` hooks first, then composes.
   * Used by `handle()` and `listen()` when there are async pre-compose
   * listeners. Sync-only composition still works via `compose()` above.
   */
  private async composeAsync(): Promise<void> {
    if (this._hooks.hasOnCompose()) {
      await this._hooks.runOnCompose()
    }
    this.compose()
  }

  // ───── Dispatch entry point (used by transports and tests) ───────────────

  /**
   * Dispatch a single context through the framework. Handles route lookup,
   * 404/405 generation, and the error boundary. The transport is responsible
   * for populating the request side of the context and writing the response
   * side after this resolves.
   */
  async handle(ctx: RiftexContext): Promise<void> {
    if (this.dirty) await this.composeAsync()

    // Stamp trust-proxy config so ctx.ip/protocol/hostname resolve correctly.
    // Non-default values only (false is the reset baseline — skip the write).
    if (this._trustProxy !== false) ctx._trustProxy = this._trustProxy

    // Hot-path: skip plugin work entirely when nothing is registered.
    const hooks = this._hooks
    const decorators = this._decorators
    const hasHooks = hooks.hasAny()
    const hasDecorators = decorators.hasAny()

    try {
      if (hasHooks && hooks.hasOnRequest()) {
        await hooks.runOnRequest(ctx)
      }
      if (hasDecorators) {
        decorators.applyTo(ctx)
      }

      const match = this.trie.find(ctx.method, ctx.path)
      if ('handler' in match) {
        // Only assign params when the route actually has them — otherwise
        // ctx.params already points at the frozen empty sentinel from reset.
        if (match.params !== EMPTY_PARAMS) {
          ctx.params = match.params as never
        }
        await match.handler(ctx)

        if (hasHooks && hooks.hasOnResponse()) {
          await hooks.runOnResponse(ctx)
        }
        return
      }
      // Miss — but middleware that mounts a path-handler (e.g. `riftex.static()`)
      // expects to run on requests that don't match a registered route. Build a
      // fall-through chain from any global + mount-prefix-matching middleware
      // and let it have a shot. If it writes the response, we're done; if it
      // calls next() or doesn't write, we surface the original 404/405.
      await this.runFallback(ctx, missToError(match))
      if (hasHooks && hooks.hasOnResponse()) {
        await hooks.runOnResponse(ctx)
      }
    } catch (err) {
      // Observation hook fires BEFORE the error boundary writes a response.
      // The boundary still owns the actual response — these hooks cannot
      // swallow or replace the error.
      if (hasHooks && hooks.hasOnError()) {
        await hooks.runOnError(err, ctx)
      }
      await this.handleError(err, ctx)
    }
  }

  /**
   * Run global + path-matching scoped middleware as a fallback chain when the
   * trie has no matching route. The terminal handler re-throws the original
   * trie miss so the error boundary still produces 404/405 if no middleware
   * wrote the response. Composed per-request — misses are exceptional.
   */
  private async runFallback(ctx: RiftexContext, miss: RiftexError): Promise<void> {
    const flat = this._flat
    if (!flat) {
      throw miss
    }
    const applicable: RiftexMiddleware[] = [...flat.globalMiddleware]
    for (const scoped of flat.scopedMiddleware) {
      if (pathStartsWith(ctx.path, scoped.prefix)) applicable.push(scoped.mw)
    }
    if (applicable.length === 0) {
      throw miss
    }
    // No-op terminal — let middleware finish completely (including post-next
    // hooks). If nothing wrote a response, surface the trie miss as a 404/405.
    const chain = composeWithHandler(applicable, () => {})
    await chain(ctx)
    if (!ctx._written) throw miss
  }

  private async handleError(err: unknown, ctx: RiftexContext): Promise<void> {
    // Reset response state in case a partial helper had been called.
    if (this.errorHandler) {
      try {
        await this.errorHandler(err, ctx)
        return
      } catch (rethrow) {
        err = rethrow
      }
    }
    writeDefaultError(err, ctx)
  }

  // ───── Transport ─────────────────────────────────────────────────────────

  /** Bind a port and accept requests. Returns a handle for graceful shutdown. */
  async listen(port: number, host?: string): Promise<ListeningServer> {
    if (this.dirty) await this.composeAsync()
    this.transport.attach({
      acquire: () => this.pool.acquire(),
      release: (ctx) => this.pool.release(ctx),
      dispatch: (ctx) => this.handle(ctx),
    })
    return host !== undefined ? this.transport.listen(port, host) : this.transport.listen(port)
  }
}

function missToError(miss: MatchMiss): RiftexError {
  if (miss.kind === 'not-found') return new RiftexNotFoundError()
  return new RiftexMethodNotAllowedError(miss.allowed)
}

function writeDefaultError(err: unknown, ctx: RiftexContext): void {
  if (err instanceof RiftexError) {
    if (err instanceof RiftexMethodNotAllowedError) {
      ctx.set('allow', err.allowed.join(', '))
    }
    const payload: Record<string, unknown> = { error: err.message, code: err.code }
    if ('fields' in err && err.fields) payload.fields = err.fields
    ctx.json(payload, err.statusCode)
    return
  }
  // Unknown error → 500
  const message = (err as Error)?.message ?? 'Internal Server Error'
  ctx.json({ error: message, code: 'INTERNAL_ERROR' }, 500)
}

function pathStartsWith(path: string, prefix: string): boolean {
  if (prefix === '') return true
  if (!path.startsWith(prefix)) return false
  // Boundary check: '/api' must not match '/apiary'.
  const after = path.charCodeAt(prefix.length)
  return Number.isNaN(after) || after === 47 // '/'
}

/**
 * Factory function. Mirrors the `express()` ergonomics — `riftex(...)` returns
 * a new app, and the function carries the body-parser middleware factories
 * plus a `Router` constructor as static properties.
 */
export interface RiftexFactory {
  (options?: RiftexAppOptions): RiftexApp
  Router: () => Router
}

/** Match: `void` for error-handler that delegates. (Used by the type tests.) */
export type RiftexErrorReturn = unknown | Promise<unknown>

/** Function-with-properties factory created and exported by `index.ts`. */
export function makeRiftexFactory(): RiftexFactory {
  const fn = ((options?: RiftexAppOptions) => new RiftexApp(options)) as RiftexFactory
  fn.Router = () => new Router()
  return fn
}

/** Match path-with-prefix exported for tests. */
export const _internal_pathStartsWith = pathStartsWith
