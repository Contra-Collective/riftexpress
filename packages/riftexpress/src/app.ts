import { AsyncLocalStorage } from 'node:async_hooks'
import { RiftexContext } from './context/context.ts'
import { RiftexContextPool } from './context/pool.ts'
import {
  RiftexError,
  RiftexHaltError,
  RiftexMethodNotAllowedError,
  RiftexNotFoundError,
  RiftexTimeoutError,
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
import { registerAfter, registerBefore } from './sinatra/filters.ts'
import { EMPTY_PARAMS, RouterTrie, type MatchMiss } from './router/trie.ts'
import type { HttpMethod } from './router/types.ts'
import { NodeAdapter } from './transport/node.ts'
import type { ListeningServer, Transport } from './transport/types.ts'
import { descriptorKey, type RouteDescriptor } from './openapi/describe.ts'
import { QueueRegistry } from './jobs/registry.ts'
import type { JobHandle, QueueOptions, QueueWorker } from './jobs/types.ts'
import { CronRegistry } from './cron/registry.ts'
import type { CronHandler, CronOptions } from './cron/scheduler.ts'

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
  /**
   * Maximum wall-clock time (ms) for a single request to complete from
   * dispatch to response. When exceeded, throws `RiftexTimeoutError(503)`
   * and the response becomes 503 Service Unavailable.
   *
   * The handler that timed out is NOT cancelled — JavaScript can't safely
   * cancel a Promise. The framework just stops waiting for it; the in-flight
   * work continues until it naturally completes or the process exits. This
   * means a slow handler can still leak compute (but not connections or
   * pool slots, since the response is sent and the context is released).
   *
   * Scoped to HTTP request handling only — does NOT apply to upgraded
   * connections (WebSocket, SSE) which are explicitly long-lived.
   *
   * Default: undefined (no timeout). Production deploys SHOULD set this.
   */
  requestTimeoutMs?: number
  /**
   * Hard ceiling (bytes) on the total request body, enforced at the
   * transport layer — applies regardless of which `ctx.body.*` consumer
   * reads the body, including `ctx.body.stream()`. Defaults to **2 MiB**
   * (2_097_152) — high enough for typical JSON / form payloads,
   * low enough that an unauthenticated attacker can't exhaust memory.
   *
   * Per-call limits on `ctx.body.json(schema, maxBytes)` etc. are still
   * honored and apply WITHIN this ceiling. To allow larger uploads on a
   * specific route, raise this AND use `ctx.body.stream()` with your own
   * size accounting.
   *
   * Set to `Infinity` to disable (NOT recommended outside controlled deploys).
   */
  maxRequestBytes?: number

  /**
   * Default queue-drain timeout (ms) used when the listener closes. Per-queue
   * timeouts can also be passed to `app.queues.drainAll(timeoutMs)`. Default
   * `10_000`ms — matches `gracefulShutdown`'s default `gracefulTimeoutMs`.
   */
  queueDrainTimeoutMs?: number
}

/** Default transport-layer body ceiling — see {@link RiftexAppOptions.maxRequestBytes}. */
const DEFAULT_MAX_REQUEST_BYTES = 2_097_152

/** A user-supplied error handler. Return a non-error or call a `ctx` writer to recover. */
export type RiftexErrorHandler = (err: unknown, ctx: RiftexContext) => unknown | Promise<unknown>

/**
 * Per-route options object accepted as the second positional arg to a verb
 * registration (`app.get(path, { auth: ['admin'] }, handler)`). Each key must
 * match a registered declarator (see `app.declare(...)`); the value is passed
 * to the declarator's factory at REGISTRATION time and the resulting
 * middleware is prepended to the route's chain.
 */
export type RouteOptions = Record<string, unknown>

/**
 * Variadic arg shape accepted by `app.get/post/...` and `app.method(...)` after
 * the leading `(method?, path)`. The tail is always one handler; everything
 * before it is either positional middleware or the (optional) leading options
 * object. We type it as `unknown[]` at the implementation seam because TS
 * tuple-rest narrowing fights with the overload's union return type — the
 * runtime validates structure (handler-is-function tail, plain-object head
 * detection, function middleware) and the public overloads enforce the shape
 * the caller actually sees.
 */
export type VerbArgs = unknown[]

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
  /** @internal Per-route OpenAPI metadata. Keyed by `${method} ${path}`. */
  private readonly _routeDescriptors: Map<string, RouteDescriptor> = new Map()
  /** @internal Bumped on every `describe()` call so the OpenAPI handler's cache invalidates. */
  private _routeDescriptorVersion = 0
  /** @internal Carried onto each `RiftexContext` so its `ip`/`protocol`/`hostname` getters can resolve. */
  private readonly _trustProxy: import('./proxy/trust.ts').TrustProxy
  /** @internal Wall-clock per-request ceiling. `undefined` disables the race entirely. */
  private readonly _requestTimeoutMs: number | undefined
  /**
   * @internal Hard transport-layer ceiling on request body bytes. Passed to
   * the transport via `TransportHooks.maxRequestBytes`. `Infinity` disables.
   */
  private readonly _maxRequestBytes: number
  /** @internal Background job registry. Workers start at compose() / first request. */
  private readonly _queues: QueueRegistry = new QueueRegistry()
  /** @internal Cron job registry. Timers start at compose() / first request. */
  private readonly _crons: CronRegistry = new CronRegistry()
  /** @internal Default queue-drain timeout used when the listener closes. */
  private readonly _queueDrainTimeoutMs: number

  constructor(options: RiftexAppOptions = {}) {
    this.pool = new RiftexContextPool(options.poolSize ?? 1024)
    this.transport = options.transport ?? new NodeAdapter()
    this._trustProxy = options.trustProxy ?? false
    this._requestTimeoutMs = options.requestTimeoutMs
    this._maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES
    this._queueDrainTimeoutMs = options.queueDrainTimeoutMs ?? 10_000

    // Wire `ctx.queue(name)` as a lazy decorator. Returns a per-call handle
    // that delegates straight to the registry. Lazy = zero overhead for
    // routes that don't enqueue background work.
    this._decorators.decorate('queue', (_ctx) => {
      return <TData = unknown>(name: string): JobHandle<TData> => {
        const q = this._queues.get<TData>(name)
        return { add: (data: TData) => q.add(data) }
      }
    })
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

  // ───── Verb registration ──────────────────────────────────────────────
  // Three accepted shapes per verb:
  //   1. (path, handler)                              — back-compat single arg
  //   2. (path, ...inlineMiddleware, handler)         — Express positional mw
  //   3. (path, optionsObject, ...inlineMw, handler)  — declarative middleware
  //                                                     (see app.declare())
  // Detection of shape (3) is by `isPlainOptionsObject(args[0])` — see the
  // helper for the exact prototype-check rule. Translation from declarative
  // options → middleware happens at REGISTRATION time, not request time, so
  // the per-request hot path has zero declarative-middleware overhead.

  get(path: string, handler: RiftexHandler): this
  get(
    path: string,
    optsOrFirst: RouteOptions | RiftexMiddleware,
    ...rest: [...RiftexMiddleware[], RiftexHandler]
  ): this
  get(path: string, ...args: VerbArgs): this {
    return (this.method as (m: HttpMethod, p: string, ...a: VerbArgs) => this)('GET', path, ...args)
  }

  post(path: string, handler: RiftexHandler): this
  post(
    path: string,
    optsOrFirst: RouteOptions | RiftexMiddleware,
    ...rest: [...RiftexMiddleware[], RiftexHandler]
  ): this
  post(path: string, ...args: VerbArgs): this {
    return (this.method as (m: HttpMethod, p: string, ...a: VerbArgs) => this)('POST', path, ...args)
  }

  put(path: string, handler: RiftexHandler): this
  put(
    path: string,
    optsOrFirst: RouteOptions | RiftexMiddleware,
    ...rest: [...RiftexMiddleware[], RiftexHandler]
  ): this
  put(path: string, ...args: VerbArgs): this {
    return (this.method as (m: HttpMethod, p: string, ...a: VerbArgs) => this)('PUT', path, ...args)
  }

  patch(path: string, handler: RiftexHandler): this
  patch(
    path: string,
    optsOrFirst: RouteOptions | RiftexMiddleware,
    ...rest: [...RiftexMiddleware[], RiftexHandler]
  ): this
  patch(path: string, ...args: VerbArgs): this {
    return (this.method as (m: HttpMethod, p: string, ...a: VerbArgs) => this)('PATCH', path, ...args)
  }

  delete(path: string, handler: RiftexHandler): this
  delete(
    path: string,
    optsOrFirst: RouteOptions | RiftexMiddleware,
    ...rest: [...RiftexMiddleware[], RiftexHandler]
  ): this
  delete(path: string, ...args: VerbArgs): this {
    return (this.method as (m: HttpMethod, p: string, ...a: VerbArgs) => this)('DELETE', path, ...args)
  }

  head(path: string, handler: RiftexHandler): this
  head(
    path: string,
    optsOrFirst: RouteOptions | RiftexMiddleware,
    ...rest: [...RiftexMiddleware[], RiftexHandler]
  ): this
  head(path: string, ...args: VerbArgs): this {
    return (this.method as (m: HttpMethod, p: string, ...a: VerbArgs) => this)('HEAD', path, ...args)
  }

  options(path: string, handler: RiftexHandler): this
  options(
    path: string,
    optsOrFirst: RouteOptions | RiftexMiddleware,
    ...rest: [...RiftexMiddleware[], RiftexHandler]
  ): this
  options(path: string, ...args: VerbArgs): this {
    return (this.method as (m: HttpMethod, p: string, ...a: VerbArgs) => this)('OPTIONS', path, ...args)
  }

  /**
   * Register a route under any HTTP method. Accepts the variadic shape with
   * an optional declarative-options object as the first arg (after `path`).
   */
  method(method: HttpMethod, path: string, handler: RiftexHandler): this
  method(
    method: HttpMethod,
    path: string,
    optsOrFirst: RouteOptions | RiftexMiddleware,
    ...rest: [...RiftexMiddleware[], RiftexHandler]
  ): this
  method(method: HttpMethod, path: string, ...args: VerbArgs): this {
    if (args.length === 0) {
      throw new TypeError(`RiftexApp.${method.toLowerCase()}('${path}'): handler is required`)
    }
    // Translate the optional declarative-options object (when present in
    // position 0) into prepended middleware. The remaining args are passed
    // through to the inner Router as plain positional middleware + handler.
    let translatedHead: RiftexMiddleware[] = []
    let tail: unknown[] = args
    if (isPlainOptionsObject(args[0])) {
      translatedHead = this.translateRouteOptions(method, path, args[0] as RouteOptions)
      tail = args.slice(1)
    }
    if (tail.length === 0) {
      throw new TypeError(`RiftexApp.${method.toLowerCase()}('${path}'): handler is required`)
    }
    // Pass through to Router. The Router validates handler-is-function and
    // each inline middleware-is-function — we don't duplicate those checks.
    this.router.method(
      method,
      path,
      ...(translatedHead.concat(tail as RiftexMiddleware[]) as [...RiftexMiddleware[], RiftexHandler]),
    )
    this.dirty = true
    return this
  }

  // ───── Declarative middleware (per-route via options object) ───────────

  /**
   * @internal Registry of declarators. Looked up at REGISTRATION time, not
   * request time — so unknown-declarator errors fire eagerly and the per-
   * request hot path stays clean.
   */
  private readonly _declarators: Map<string, (opts: unknown) => RiftexMiddleware> = new Map()

  /**
   * Register a declarator: a name → middleware-factory mapping. When a route
   * registration includes an options object with that name as a key, the value
   * is passed to the factory and the resulting middleware is composed into
   * the route's chain (in the same position as positional inline middleware,
   * but BEFORE any positional middleware on the same call).
   *
   * Declarators are global to the app and survive across all subsequent route
   * registrations until overridden by a second `declare(name, ...)` call.
   * Lookup is REGISTRATION-time: a route registered before the matching
   * `declare(...)` call throws at registration with a clear hint, not at
   * request time. This trades flexibility for debuggability — the error is
   * caught at boot, not under load.
   *
   * @example
   *   app.declare('auth', (roles: string[]) => requireRoles(roles))
   *   app.declare('rateLimit', (spec: string) => parseRateLimitSpec(spec))
   *   app.get('/admin', { auth: ['admin'], rateLimit: '10/min' }, handler)
   */
  declare<O>(name: string, factory: (opts: O) => RiftexMiddleware): this {
    this._declarators.set(name, factory as (opts: unknown) => RiftexMiddleware)
    return this
  }

  /**
   * @internal Resolve a route's options object into a list of middleware by
   * looking up each key in the declarator registry. Iterates keys in object
   * insertion order (ES2015+ guarantee for string keys). Throws at REG TIME
   * with a contextual message when a key has no registered declarator.
   */
  private translateRouteOptions(
    method: HttpMethod,
    path: string,
    opts: RouteOptions,
  ): RiftexMiddleware[] {
    const out: RiftexMiddleware[] = []
    for (const key of Object.keys(opts)) {
      const factory = this._declarators.get(key)
      if (!factory) {
        throw new Error(
          `app.${method.toLowerCase()}('${path}', { ${key}: ... }, ...): unknown declarator '${key}'. ` +
            `Did you forget to call app.declare('${key}', ...)?`,
        )
      }
      out.push(factory(opts[key]))
    }
    return out
  }

  /** Register a global error handler. Re-throw to delegate to the default boundary. */
  onError(handler: RiftexErrorHandler): this {
    this.errorHandler = handler
    return this
  }

  // ───── Sinatra-style filters ───────────────────────────────────────────────

  /**
   * Register a `before` filter — runs BEFORE the route handler resolves.
   * The user writes only the body; `await next()` is called automatically
   * after it returns. If the body writes a response (e.g. `ctx.json(...)`)
   * the chain short-circuits and the route handler does not run.
   *
   * - `before(handler)` — runs for every request (global).
   * - `before(pattern, handler)` — boundary-respecting prefix match
   *   (`/admin/*` and `/admin` both match `/admin` and `/admin/x`, neither
   *   matches `/administrator`). See `sinatra/filters.ts` for details.
   */
  before(handler: RiftexMiddleware): this
  before(pattern: string, handler: RiftexMiddleware): this
  before(arg1: string | RiftexMiddleware, arg2?: RiftexMiddleware): this {
    if (typeof arg1 === 'string') registerBefore(this, arg1, arg2 as RiftexMiddleware)
    else registerBefore(this, arg1)
    return this
  }

  /**
   * Register an `after` filter — runs AFTER the route handler resolves but
   * BEFORE the adapter writes the response to the wire. The filter sees the
   * final ctx state (status, headers, body buffer) and may inspect or
   * augment it. Errors thrown by the filter propagate to the error boundary.
   *
   * - `after(handler)` — runs for every request (global).
   * - `after(pattern, handler)` — same prefix semantics as `before`.
   */
  after(handler: RiftexMiddleware): this
  after(pattern: string, handler: RiftexMiddleware): this
  after(arg1: string | RiftexMiddleware, arg2?: RiftexMiddleware): this {
    if (typeof arg1 === 'string') registerAfter(this, arg1, arg2 as RiftexMiddleware)
    else registerAfter(this, arg1)
    return this
  }

  /**
   * Attach OpenAPI metadata to a route. The route must be registered separately
   * via `app.get/post/...`. Multiple calls overwrite the previous descriptor
   * for the same `(method, path)` pair. Reads via `generateOpenApi(app)`.
   */
  describe(method: HttpMethod, path: string, meta: RouteDescriptor): this {
    this._routeDescriptors.set(descriptorKey(method, path), meta)
    this._routeDescriptorVersion++
    return this
  }

  /** @internal Read-only view of route descriptors — used by the OpenAPI generator. */
  get routeDescriptors(): ReadonlyMap<string, RouteDescriptor> {
    return this._routeDescriptors
  }

  /** @internal Bumps on every `describe()` call so the OpenAPI handler can cache-bust. */
  get routeDescriptorVersion(): number {
    return this._routeDescriptorVersion
  }

  /** @internal Read-only view of the registration journal — used by the OpenAPI generator. */
  get routerJournal(): Router {
    return this.router
  }

  // ───── Background jobs + cron ───────────────────────────────────────────

  /**
   * Register a background queue with a worker. The worker pool starts when
   * the app is composed (first request, `app.compose()`, or `app.listen()`).
   *
   * @example
   * app.queue<{ to: string; body: string }>('emails',
   *   { concurrency: 4, retries: 5 },
   *   async (job) => sendEmail(job.data),
   * )
   *
   * // From a route handler:
   * app.post('/signup', async (ctx) => {
   *   const u = await createUser(await ctx.body.json())
   *   await ctx.queue('emails').add({ to: u.email, body: 'Welcome!' })
   *   return { ok: true }
   * })
   */
  queue<TData>(name: string, opts: QueueOptions<TData>, worker: QueueWorker<TData>): this
  queue<TData>(name: string, worker: QueueWorker<TData>): this
  queue<TData>(
    name: string,
    optsOrWorker: QueueOptions<TData> | QueueWorker<TData>,
    maybeWorker?: QueueWorker<TData>,
  ): this {
    const opts: QueueOptions<TData> = typeof optsOrWorker === 'function' ? {} : optsOrWorker
    const worker: QueueWorker<TData> =
      typeof optsOrWorker === 'function' ? optsOrWorker : (maybeWorker as QueueWorker<TData>)
    if (typeof worker !== 'function') {
      throw new TypeError(`riftexpress: app.queue("${name}", ...) requires a worker function`)
    }
    this._queues.register<TData>(name, opts, worker)
    this.dirty = true
    return this
  }

  /**
   * Register a cron job. Spec is a 5-field crontab string. See
   * `src/cron/parser.ts` for the supported grammar.
   *
   * @example
   * app.cron('0 *\/15 * * *', () => refreshCaches())   // every 15 min
   * app.cron('0 0 * * 0', { timezone: 'America/Los_Angeles' }, weeklyReport)
   */
  cron(spec: string, handler: CronHandler): this
  cron(spec: string, opts: CronOptions, handler: CronHandler): this
  cron(
    spec: string,
    optsOrHandler: CronOptions | CronHandler,
    maybeHandler?: CronHandler,
  ): this {
    const opts: CronOptions = typeof optsOrHandler === 'function' ? {} : optsOrHandler
    const handler: CronHandler =
      typeof optsOrHandler === 'function' ? optsOrHandler : (maybeHandler as CronHandler)
    if (typeof handler !== 'function') {
      throw new TypeError('riftexpress: app.cron(spec, ..., handler) requires a handler function')
    }
    this._crons.register(spec, opts, handler)
    this.dirty = true
    return this
  }

  /** @internal Read-only access to the queue registry for ops/test introspection. */
  get queues(): QueueRegistry { return this._queues }
  /** @internal Read-only access to the cron registry for ops/test introspection. */
  get crons(): CronRegistry { return this._crons }

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

      // Splice inline middleware (positional + declarative-translated) AFTER
      // global + scoped middleware AND BEFORE the terminal handler. This
      // matches Express's positional-mw semantics and is the foundation
      // `app.declare()` builds on.
      if (route.inlineMiddleware && route.inlineMiddleware.length > 0) {
        for (const mw of route.inlineMiddleware) applicable.push(mw)
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

    // Start cron timers + queue worker pools at compose time so they don't
    // process work before the app is wired up. Both `startAll` calls are
    // idempotent — safe to run on every recompose triggered by the dirty bit.
    this._crons.startAll()
    this._queues.startAll()
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

    // Back-reference so app-aware handlers (e.g. openapiHandler) can reach
    // the app from inside a route handler. ctx.state is reset per request
    // by the pool, so this doesn't leak between requests.
    ctx.state._riftexApp = this

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
        // Wrap the dispatch in a wall-clock race AND a closure-bound
        // late-write guard on the response writers. The race is HTTP-
        // request-scoped only — WS / SSE upgrades bypass this path because
        // they're dispatched through their own adapters and never resolve
        // back to a normal HTTP response. See `withEpochGuard` for the
        // mechanism that prevents orphaned handlers from corrupting the
        // next request bound to this same pooled context instance.
        if (this._requestTimeoutMs !== undefined) {
          await withEpochGuard(ctx, this._requestTimeoutMs, () => match.handler(ctx))
        } else {
          await match.handler(ctx)
        }

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
      maxRequestBytes: this._maxRequestBytes,
    })
    const handle = host !== undefined
      ? await this.transport.listen(port, host)
      : await this.transport.listen(port)

    // Wrap the underlying close so cron timers + queue worker pools are torn
    // down as part of graceful shutdown. Sockets and queues drain in parallel
    // (wall-clock bounded by max(socket-drain, queue-drain), not their sum).
    const drainTimeout = this._queueDrainTimeoutMs
    const queues = this._queues
    const crons = this._crons
    const wrappedClose: ListeningServer['close'] = async (closeOpts) => {
      // Stop cron tickers FIRST so they don't enqueue new work mid-shutdown.
      crons.stopAll()
      const queueDrain = queues.drainAll(drainTimeout)
      const socketClose = handle.close(closeOpts)
      const [, drainResult] = await Promise.all([socketClose, queueDrain])
      if (drainResult.timedOut.length > 0) {
        try {
          process.emitWarning(
            `riftexpress: queues did not drain within ${drainTimeout}ms: ${drainResult.timedOut.join(', ')}`,
            { type: 'RiftexQueueDrainWarning' },
          )
        } catch {
          /* worker contexts may throw on emitWarning */
        }
      }
    }
    return { ...handle, close: wrappedClose }
  }
}

function missToError(miss: MatchMiss): RiftexError {
  if (miss.kind === 'not-found') return new RiftexNotFoundError()
  return new RiftexMethodNotAllowedError(miss.allowed)
}

function writeDefaultError(err: unknown, ctx: RiftexContext): void {
  if (err instanceof RiftexHaltError) {
    // Halt body shape was decided at the call site (`ctx.halt`):
    //   - 'text'  → body is a string, write as text/plain verbatim
    //   - 'json'  → body is an object, write as application/json verbatim
    //   - 'none'  → no body provided, fall through to default JSON shape
    if (err.bodyShape === 'text') {
      ctx.text(err.body as string, err.statusCode)
      return
    }
    if (err.bodyShape === 'json') {
      ctx.json(err.body as Record<string, unknown>, err.statusCode)
      return
    }
    ctx.json({ error: err.message, code: err.code }, err.statusCode)
    return
  }
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

/**
 * Detect whether a value is a "plain options object" — i.e. the declarative
 * route-options shape (`{ auth: [...], rateLimit: '...' }`) — vs anything
 * else that might be in argument-position 0 (a middleware function, a
 * handler function, a class instance, a Buffer, an Array, etc).
 *
 * Rule: must be non-null, `typeof === 'object'`, NOT a function, NOT an
 * Array, and `Object.getPrototypeOf(v)` is either `Object.prototype` or
 * `null` (covers `Object.create(null)` bags). Class instances have a
 * non-Object prototype and are correctly rejected. This is a stricter check
 * than `typeof === 'object'` alone — we want false positives to be near-
 * impossible because misclassifying a middleware as options would bury the
 * mistake under "unknown declarator" errors.
 */
function isPlainOptionsObject(v: unknown): v is RouteOptions {
  if (v === null || typeof v !== 'object') return false
  if (typeof v === 'function') return false
  if (Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v) as object | null
  return proto === null || proto === Object.prototype
}

/**
 * Race a dispatched handler against a wall-clock deadline. Resolves when
 * the handler does, or rejects with `RiftexTimeoutError` if the deadline
 * fires first. The handler promise is NOT cancelled (JS can't) — it's just
 * orphaned. We bump `ctx._epoch` at timeout so any subsequent writes from
 * the orphaned handler hit the epoch-guard installed around the dispatch
 * and get swallowed instead of corrupting the next request.
 *
 * The timer is `unref`'d so a fast handler that resolves naturally doesn't
 * keep the event loop alive waiting for the timeout to fire.
 */
function raceWithTimeout(
  dispatch: Promise<unknown> | unknown,
  timeoutMs: number,
  ctx: RiftexContext,
  capturedEpoch: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      // Bump the epoch so the orphaned handler's late writes are detected
      // by the guard wrappers as stale and discarded. This is what
      // prevents cross-request response corruption when the ctx is
      // recycled and rebound to a new request.
      if (ctx._epoch === capturedEpoch) ctx._epoch++
      reject(new RiftexTimeoutError(timeoutMs))
    }, timeoutMs)
    // Crucially, never keep the event loop alive. A handler that resolves
    // in 5ms with a 30s timeout configured should not block process exit.
    timer.unref?.()
    Promise.resolve(dispatch).then(
      (v) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(v as void)
      },
      (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/**
 * Per-dispatch async-context store. Carries the epoch captured at dispatch
 * entry through every `await` in the handler chain. The orphaned handler
 * of a timed-out dispatch keeps running inside its OWN ALS frame even
 * after `Promise.race` rejects in `handle()`, so its `als.getStore()`
 * still returns the original captured epoch. The next request runs in a
 * different ALS frame (because `als.run(...)` was called fresh), so its
 * store is its own captured epoch. This is the ONLY reliable way to
 * distinguish "the orphan calling `ctx.json`" from "the legitimate next
 * request calling `ctx.json`" — ctx state alone cannot.
 */
const dispatchEpochStore: AsyncLocalStorage<number> = new AsyncLocalStorage()

/**
 * Run `fn()` under both the wall-clock race AND a per-dispatch late-write
 * guard. The guard installs closure-bound wrappers around `ctx`'s response
 * writers; each wrapper checks `dispatchEpochStore.getStore()` (carried by
 * `AsyncLocalStorage` through every `await` in the handler chain) against
 * the epoch captured at dispatch entry. When they diverge — because the
 * timeout path bumped `ctx._epoch` and we're now executing inside a stale
 * orphan continuation — the wrapper swallows the write and emits a single
 * `RiftexLateWriteWarning` so leaks remain observable in production.
 *
 * Behavior:
 * - Dispatch resolves naturally → restore originals (no orphan possible).
 * - Dispatch times out → bump `_epoch` (so any check against the captured
 *   value fails), `Promise.race` rejects with `RiftexTimeoutError`, the
 *   error boundary writes the 503. The orphaned handler keeps running in
 *   its own ALS frame; its eventual `ctx.json(...)` is detected as stale
 *   either by (a) the still-installed wrapper (if no new request has
 *   re-wrapped) — store mismatch → swallow; or (b) the next request's
 *   wrapper, which compares the orphan's ALS-store epoch against its own
 *   captured value → mismatch → swallow.
 *
 * The error boundary itself runs OUTSIDE the orphan's ALS frame (it
 * executes synchronously after the `await` in `handle()`), so its
 * `als.getStore()` returns `undefined`, which the wrapper treats as "no
 * guard active for this caller" and lets through.
 *
 * The timer is `unref`'d so a fast handler that resolves naturally doesn't
 * keep the event loop alive waiting for the timeout to fire.
 */
async function withEpochGuard(
  ctx: RiftexContext,
  timeoutMs: number,
  fn: () => Promise<unknown> | unknown,
): Promise<void> {
  const capturedEpoch = ctx._epoch
  ctx._dispatchEpoch = capturedEpoch

  // Snapshot originals — un-wrapped methods we restore on dispatch end.
  const originals = {
    json: ctx.json,
    text: ctx.text,
    html: ctx.html,
    send: ctx.send,
    redirect: ctx.redirect,
    stream: ctx.stream,
  }

  // The closure + ALS combined check. `capturedEpoch` is the per-dispatch
  // identity. We swallow ONLY when this wrapper's own orphan is calling:
  // the ALS store still says "you're inside dispatch N" (because the
  // orphan kept running its async chain past the timeout) BUT the live
  // `_epoch` has moved on (because the timeout path bumped it). For every
  // other caller — the legitimate handler under THIS dispatch, the error
  // boundary (no store), the next dispatch's handler (different store) —
  // we pass through to the underlying writer. With wrappers stacked
  // across recycled contexts, each layer detects only its own orphan and
  // forwards everything else; the deepest layer is the original writer.
  const guarded = (orig: (...args: never[]) => unknown) =>
    function guardedWriter(this: RiftexContext, ...args: unknown[]): unknown {
      const callerEpoch = dispatchEpochStore.getStore()
      // Only my-own-orphan path swallows: caller is in the same ALS frame
      // I installed, but the live epoch has been bumped past my captured
      // value (timeout fired or the ctx was recycled).
      if (callerEpoch === capturedEpoch && ctx._epoch !== capturedEpoch) {
        try {
          process.emitWarning(
            'Late response write after timeout — handler may be leaking',
            { type: 'RiftexLateWriteWarning' },
          )
        } catch {
          // process.emitWarning can throw in unusual runtimes (workers); swallow.
        }
        return undefined
      }
      return (orig as (...a: unknown[]) => unknown).apply(ctx, args)
    }

  ctx.json = guarded(originals.json) as typeof ctx.json
  ctx.text = guarded(originals.text) as typeof ctx.text
  ctx.html = guarded(originals.html) as typeof ctx.html
  ctx.send = guarded(originals.send) as typeof ctx.send
  ctx.redirect = guarded(originals.redirect) as typeof ctx.redirect
  ctx.stream = guarded(originals.stream) as typeof ctx.stream

  const restore = (): void => {
    ctx.json = originals.json
    ctx.text = originals.text
    ctx.html = originals.html
    ctx.send = originals.send
    ctx.redirect = originals.redirect
    ctx.stream = originals.stream
    ctx._dispatchEpoch = 0
  }

  try {
    await dispatchEpochStore.run(capturedEpoch, () =>
      raceWithTimeout(fn(), timeoutMs, ctx, capturedEpoch),
    )
    // Success path: no orphan can exist. Restore originals so we don't
    // accumulate dead wrappers on the pooled context across thousands of
    // successful requests.
    restore()
  } catch (err) {
    // Failure path. If it's a timeout, the orphaned handler is still alive
    // and may eventually call ctx.json/text/...; we KEEP the wrapper
    // installed so its ALS-store check can detect and swallow those late
    // writes. The error boundary itself runs outside the orphan's ALS
    // frame, so its writes pass through (no store ⇒ no swallow).
    //
    // For non-timeout errors (handler threw synchronously, etc.) there's
    // no orphan to defend against, so restore for hygiene.
    if (err instanceof RiftexTimeoutError) {
      ctx._dispatchEpoch = 0 // Stop advertising "active dispatch"; wrapper still inspects ALS store.
    } else {
      restore()
    }
    throw err
  }
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
