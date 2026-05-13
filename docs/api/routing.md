# Routing — `Router`, path syntax, `ExtractParams`

The router is a radix trie matched at request time. Registrations are journaled, not eagerly composed; the trie is rebuilt the first time a request arrives (or when `app.compose()` is called explicitly). Every leaf in the trie holds a per-method composed middleware-plus-handler chain.

## `Router()` — factory

```ts
import { Router } from 'riftexpress'
// or: const Router = riftex.Router

const r = Router()
```

Constructs a fresh `Router`. Both `Router()` and `riftex.Router()` resolve to the same constructor. There is no required argument.

## `Router` instance API

```ts
class Router {
  use(mw: RiftexMiddleware): this
  use(prefix: string, mw: RiftexMiddleware | Router): this

  get(path, handler): this
  post(path, handler): this
  put(path, handler): this
  patch(path, handler): this
  delete(path, handler): this
  head(path, handler): this
  options(path, handler): this

  method(method: HttpMethod, path: string, handler: RiftexHandler): this
}
```

`Router` has the same registration surface as `RiftexApp` — minus dispatch (`handle`, `listen`), plugin (`register`, `decorate`, `hooks`), and the error handler (`onError`). Routers are pure registration; the parent app owns runtime concerns.

`use(prefix, value)` accepts either middleware or a sub-router. Throws `TypeError` for any other shape.

## Mount semantics

When you `app.use('/api', r)` (or `parent.use('/api', r)`), the parent flattens `r`'s journal at compose time, prepending `/api` to every entry:

- `r.get('/users')` becomes `/api/users` in the parent's trie.
- Middleware that was global inside `r` becomes scoped to the `/api` prefix in the parent.
- Middleware mounted inside `r` at `/v1` becomes `/api/v1` in the parent.
- Sub-routers compose recursively.

Prefix normalization: leading `/` is added if missing, trailing `/` is stripped, and `''`/`'/'` mean "no prefix" (used internally when a router is its own root).

## Path syntax

| Token | Meaning | `params` value |
|---|---|---|
| `/static` | Literal segment. | n/a |
| `/:name` | Required named param. Matches one path segment (no `/`). | `params.name: string` |
| `/:name?` | Optional named param. Matches zero or one segment. | `params.name?: string` |
| `/*name` | Greedy wildcard tail. Matches the rest of the path including `/`. | `params.name: string` |

Examples:

```ts
r.get('/users/:id',           handler)   // /users/42
r.get('/users/:id?',          handler)   // /users  AND  /users/42
r.get('/files/*path',         handler)   // /files/a/b/c.png  → params.path = 'a/b/c.png'
r.get('/blog/:year/:slug',    handler)   // /blog/2025/hello
```

### Precedence and backtrack

When multiple branches could match, the trie chooses in this order:

1. **Static** segments win over params.
2. **Param** segments win over wildcards.
3. **Wildcard** is last resort.

The matcher does a single-level backtrack: if a `:param` branch dead-ends (no continuation matches the rest of the path), the matcher rewinds and tries a `*wildcard` branch at the same point. This means `/files/:scope` and `/files/*path` can coexist on the same router — `/files/foo` resolves to `:scope`, `/files/foo/bar` falls through to `*path`.

## `HttpMethod` and `HTTP_METHODS`

```ts
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

const HTTP_METHODS: readonly HttpMethod[] = [
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
] as const
```

The string union and the corresponding readonly array. Both are exported from `'riftexpress'`. Useful for iterating every method when wiring per-method middleware or for typing `app.method(...)` arguments.

## `ExtractParams<Path>`

A template-literal type that recursively extracts named params from a path string. Used to type `ctx.params` in route handlers without manual annotation.

```ts
type ExtractParams<Path extends string> = Path extends `${string}:${infer Param}/${infer Rest}`
  ? ParamRecord<Param> & ExtractParams<`/${Rest}`>
  : Path extends `${string}:${infer Param}`
    ? ParamRecord<Param>
    : Path extends `${string}*${infer Wild}`
      ? { [K in Wild]: string }
      : Record<string, never>
```

Examples:

```ts
type A = ExtractParams<'/users/:id'>
// { id: string }

type B = ExtractParams<'/users/:id/posts/:slug?'>
// { id: string; slug?: string | undefined }

type C = ExtractParams<'/files/*path'>
// { path: string }

type D = ExtractParams<'/health'>
// Record<string, never>
```

Known limitation: `ExtractParams` does not narrow constrained params. A path like `/users/:id(\\d+)` is still typed as `string`, not `number` — Express-style regex constraints aren't currently parsed at the type level.
