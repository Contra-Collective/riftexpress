# `RiftexBody` — `ctx.body`

The lazy body accessor. One instance per `RiftexContext` (pool-bound), so the per-request cost is just a `_reset()`. The adapter attaches the request stream, content-type, and content-length on every request; nothing is read until you call a parser.

```ts
class RiftexBody {
  json<T>(schema?, maxBytes?): Promise<T>
  text(maxBytes?): Promise<string>
  urlencoded(maxBytes?): Promise<Record<string, string>>
  buffer(maxBytes?): Promise<Buffer>
  stream(): Readable
  multipart(opts?: MultipartOptions): Promise<MultipartResult>
}
```

The default size limit for `json`, `text`, `urlencoded`, `buffer`, and `multipart.maxBytes` is **100,000 bytes**, matching Express's `body-parser` default of `'100kb'`. Override per call.

## `json(schema?, maxBytes?)`

```ts
json<T = unknown>(
  schema?: StandardSchemaV1<unknown, T> | SafeParseSchema<T> | ParseSchema<T>,
  maxBytes?: number,
): Promise<T>
```

Reads the body, decodes UTF-8, then `JSON.parse` (an empty body parses as `null`). If a schema is supplied, the parsed value is validated.

Schema detection order:

1. **Standard Schema v1** — anything where `isStandardSchema(x)` returns `true` (`x['~standard'].version === 1` and `validate` is a function). Validate may be sync or async.
2. **Zod-like `safeParse(input)`** — anything with a `safeParse` method that returns `{ success, data }` or `{ success: false, error: { issues } }`.
3. **Plain `parse(input): T`** — anything with a `parse` method that returns the value or throws.

```ts
import { type } from 'arktype'
import { z } from 'zod'

// Standard Schema (any vendor)
const A = type({ name: 'string' })
const a = await ctx.body.json(A)

// Zod
const B = z.object({ name: z.string(), email: z.email() })
const b = await ctx.body.json(B)

// Plain parser
const C = { parse(x: unknown) { /* ... */ return x as { name: string } } }
const c = await ctx.body.json(C)
```

Validation failures throw `RiftexValidationError` with a `fields: Record<string, string>` map. Standard Schema and Zod paths are dot-joined (`['user','email']` → `'user.email'`); the empty path becomes `'_'`.

Throws:
- `RiftexBadRequestError` — invalid JSON.
- `RiftexValidationError` — schema rejected the parsed value.
- `RiftexPayloadTooLargeError` — body exceeded `maxBytes`.

## `text(maxBytes?)`

```ts
text(maxBytes?: number): Promise<string>
```

Buffer the body and decode as UTF-8. Default `maxBytes`: 100,000.

## `urlencoded(maxBytes?)`

```ts
urlencoded(maxBytes?: number): Promise<Record<string, string>>
```

Parse the body as `application/x-www-form-urlencoded` via `URLSearchParams`. Repeated keys collapse to the last value (use `ctx.body.text()` and parse manually if you need arrays). Default `maxBytes`: 100,000.

## `buffer(maxBytes?)`

```ts
buffer(maxBytes?: number): Promise<Buffer>
```

Buffer the entire body into a single `Buffer`. Default `maxBytes`: 100,000.

The implementation short-circuits when `Content-Length` already exceeds `maxBytes` — in that case the source is drained (so the connection can be reused) and `RiftexPayloadTooLargeError` is thrown without buffering anything. Otherwise the body is piped through a byte-counting limit stream that throws mid-stream if the cap is exceeded.

If the request had no body, returns `Buffer.alloc(0)`.

## `stream()`

```ts
stream(): Readable
```

Hand back the raw `node:stream` `Readable`. Throws `RiftexBadRequestError` if the body has already been consumed by another parser, or if the request has no body. After calling `stream()`, you own the bytes — no other parser will read them.

```ts
app.post('/upload', async (ctx) => {
  const stream = ctx.body.stream()
  await pipeline(stream, fs.createWriteStream('/tmp/upload'))
  return { ok: true }
})
```

## `multipart(opts?)`

```ts
multipart(opts?: MultipartOptions): Promise<MultipartResult>
```

Parse the body as `multipart/form-data` (RFC 7578). Returns an object of plain-text `fields` plus fully buffered `files`. For very large uploads, prefer `stream()` and parse manually — `multipart()` holds every file in memory.

### `MultipartOptions`

```ts
interface MultipartOptions {
  maxBytes?: number              // total body cap.   default 100_000
  maxFileSize?: number           // per-file cap.     default 10 * 1024 * 1024 (10 MiB)
  maxFiles?: number              // file part count.  default 20
  maxFields?: number             // text field count. default 100
  allowedMimePrefixes?: string[] // e.g. ['image/']. default: any
}
```

All limits are validated mid-parse — exceeding any throws before the full body is decoded so memory stays bounded.

### `MultipartFile`

```ts
interface MultipartFile {
  filename: string  // as supplied by client
  mimeType: string  // from part Content-Type, default 'application/octet-stream'
  size: number      // byte length of `data`
  data: Buffer      // raw bytes (fully buffered)
}
```

### `MultipartResult`

```ts
interface MultipartResult {
  fields: Record<string, string | string[]>           // repeats collapse to array
  files:  Record<string, MultipartFile | MultipartFile[]>
}
```

### Failure modes

| Throw | Cause |
|---|---|
| `RiftexPayloadTooLargeError` | Body exceeds `maxBytes`, OR a single file exceeds `maxFileSize`. |
| `RiftexBadRequestError` | Too many files / fields, disallowed MIME prefix, missing/wrong `Content-Type`, missing boundary, malformed body. |

## Schema types

```ts
interface ParseSchema<T> {
  parse(input: unknown): T
}

interface SafeParseSchema<T> {
  safeParse(input: unknown): { success: true; data: T }
                           | { success: false; error: { issues: { path: ReadonlyArray<string|number>; message: string }[] } }
}
```

Both are exported as `ParseSchema` and `SafeParseSchema` from `'riftexpress'`. See [schema.md](./schema.md) for the Standard Schema v1 surface (`StandardSchemaV1`, `isStandardSchema`, etc.).
