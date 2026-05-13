# Standard Schema integration

RiftExpress integrates with [Standard Schema v1](https://standardschema.dev) — a vendor-neutral protocol that any validation library can implement. When you pass a Standard Schema to `ctx.body.json(schema)`, the framework invokes its `validate` function, normalizes the issues into a flat `fields` map, and throws `RiftexValidationError` on failure.

The types ship locally in [`packages/riftexpress/src/schema/standard.ts`](../../packages/riftexpress/src/schema/standard.ts) — RiftExpress does **not** depend on `@standard-schema/spec`, to keep the core dependency-free. The local types mirror the spec exactly.

## Types

### `StandardSchemaV1<TIn, TOut>`

```ts
interface StandardSchemaV1<TIn = unknown, TOut = TIn> {
  readonly '~standard': StandardSchemaV1Props<TIn, TOut>
}

interface StandardSchemaV1Props<TIn = unknown, TOut = TIn> {
  readonly version: 1
  readonly vendor: string
  readonly validate: (input: unknown) => StandardResult<TOut> | Promise<StandardResult<TOut>>
  readonly types?: { readonly input: TIn; readonly output: TOut } | undefined
}
```

Anything with a `~standard` property whose `version` is `1` and whose `validate` is a function is a Standard Schema. The `types` property is type-level only — it carries `TIn` and `TOut` for inference.

### `StandardResult<T>`

```ts
type StandardResult<T> = StandardSuccessResult<T> | StandardFailureResult

interface StandardSuccessResult<TOut> {
  readonly value: TOut
  readonly issues?: undefined
}

interface StandardFailureResult {
  readonly issues: ReadonlyArray<StandardIssue>
  readonly value?: undefined
}
```

Success XOR failure — discriminated on the presence of `issues`.

### `StandardIssue`

```ts
interface StandardIssue {
  readonly message: string
  readonly path?: ReadonlyArray<PropertyKey | StandardPathSegment> | undefined
}

interface StandardPathSegment {
  readonly key: PropertyKey
}
```

Each issue has a human-readable `message` and an optional structured `path`. Segments may be bare keys (`'email'`, `0`) or wrapped objects (`{ key: 'email' }`) — RiftExpress handles both.

### `isStandardSchema(x)` — type guard

```ts
function isStandardSchema(x: unknown): x is StandardSchemaV1
```

Returns `true` when `x['~standard']` exists, has `version: 1`, and exposes a function `validate`. Cheap enough to call on every `ctx.body.json()` call.

## Detection order in `ctx.body.json()`

When you pass a schema, the body parser tries:

1. **Standard Schema v1** — `isStandardSchema(schema) === true`. `validate` may be sync or async (return value is awaited). Issues are normalized via the path-joining rules below.
2. **Zod-like `safeParse(input)`** — schema has a `safeParse` method. Issues come from `result.error.issues` with `path: ReadonlyArray<string | number>`.
3. **Plain `parse(input): T`** — schema has a `parse` method. Throws on failure — the thrown message becomes the only `_` field.

Standard Schema takes precedence even when a schema also exposes `safeParse` or `parse`.

## Path → field mapping

Each issue's `path` is dot-joined into a flat key on the `RiftexValidationError.fields` map:

| `path` | Resulting field |
|---|---|
| `undefined` or `[]` | `'_'` |
| `['email']` | `'email'` |
| `['user', 'email']` | `'user.email'` |
| `[{ key: 'items' }, 0, 'name']` | `'items.0.name'` |
| `[Symbol('s')]` | `'Symbol(s)'` (via `String(seg)`) |

Object segments with a `key` property are unwrapped (`seg.key`); other segments are stringified. Multiple issues with the same path overwrite each other in the map — the last issue wins, which is consistent with the v0.0.1 "one message per field" boundary serialization.

## Example

```ts
import { z } from 'zod'
import { type } from 'arktype'

// Zod schema — implements Standard Schema v1 in Zod v4+
const A = z.object({ name: z.string(), email: z.email() })
app.post('/zod',     async (ctx) => ctx.body.json(A))

// ArkType — Standard Schema v1 native
const B = type({ name: 'string', email: 'string' })
app.post('/arktype', async (ctx) => ctx.body.json(B))

// Plain parser
const C = { parse(x: unknown) { if (typeof x !== 'object') throw new Error('nope'); return x as { name: string } } }
app.post('/plain',   async (ctx) => ctx.body.json(C))
```

All three throw `RiftexValidationError` on failure; the default error boundary serializes it as `{ error: 'Validation Failed', code: 'VALIDATION_FAILED', fields: { ... } }` with status 422.
