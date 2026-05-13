# Errors

Every framework-emitted error extends `RiftexError`. The default error boundary serializes any `RiftexError` as `{ error, code, fields? }` with the matching HTTP status. Anything else becomes a 500.

```ts
import {
  RiftexError,
  RiftexNotFoundError,
  RiftexUnauthorizedError,
  RiftexMethodNotAllowedError,
  RiftexPayloadTooLargeError,
  RiftexValidationError,
  RiftexBadRequestError,
} from 'riftexpress'
```

## `RiftexError` — base class

```ts
class RiftexError extends Error {
  readonly statusCode: number
  readonly code: string                  // UPPER_SNAKE_CASE
  readonly cause?: unknown
  constructor(statusCode: number, code: string, message: string, cause?: unknown)
}
```

`name` is set from the constructor (`new.target.name`) so subclasses identify themselves correctly in stack traces. Use this base when defining your own framework-aware error classes — anything extending it is recognized by the default boundary.

## Built-in subclasses

### `RiftexNotFoundError` — 404

```ts
class RiftexNotFoundError extends RiftexError {
  constructor(message?: string)  // default 'Not Found'
}
// statusCode 404, code 'NOT_FOUND'
```

Thrown by the framework when no route matches the request path. Override the message to expose more context (`new RiftexNotFoundError('User not found')`).

### `RiftexUnauthorizedError` — 401

```ts
class RiftexUnauthorizedError extends RiftexError {
  constructor(message?: string)  // default 'Unauthorized'
}
// statusCode 401, code 'UNAUTHORIZED'
```

Throw from auth middleware or decorators when the request lacks valid credentials.

### `RiftexMethodNotAllowedError` — 405

```ts
class RiftexMethodNotAllowedError extends RiftexError {
  readonly allowed: readonly string[]
  constructor(allowed: readonly string[], message?: string)  // default 'Method Not Allowed'
}
// statusCode 405, code 'METHOD_NOT_ALLOWED'
```

Thrown when a route path matched but no handler is registered for the request's method. The default boundary writes the `Allow` response header from `allowed` automatically (`'GET, POST, OPTIONS'`-style).

### `RiftexPayloadTooLargeError` — 413

```ts
class RiftexPayloadTooLargeError extends RiftexError {
  constructor(message?: string)  // default 'Payload Too Large'
}
// statusCode 413, code 'PAYLOAD_TOO_LARGE'
```

Thrown by `ctx.body.json/text/urlencoded/buffer/multipart` when the body exceeds `maxBytes`, or by `ctx.body.multipart` when a single file exceeds `maxFileSize`.

### `RiftexValidationError` — 422

```ts
class RiftexValidationError extends RiftexError {
  readonly fields: Record<string, string>
  constructor(fields: Record<string, string>, message?: string)  // default 'Validation Failed'
}
// statusCode 422, code 'VALIDATION_FAILED'
```

Thrown by `ctx.body.json(schema)` when the parsed value fails validation. Each entry in `fields` maps a dot-joined field path to a human-readable message; the empty path becomes `'_'`. The `fields` map is included in the default boundary's serialized response.

### `RiftexBadRequestError` — 400

```ts
class RiftexBadRequestError extends RiftexError {
  constructor(message?: string, cause?: unknown)  // default 'Bad Request'
}
// statusCode 400, code 'BAD_REQUEST'
```

Thrown for malformed input — invalid JSON, body already consumed, missing body, malformed multipart, missing `Content-Type` for multipart, etc.

## Default boundary

```jsonc
// status: <RiftexError.statusCode>
// content-type: application/json; charset=utf-8
{
  "error": "<message>",
  "code":  "<CODE>",
  "fields": { /* present only on RiftexValidationError */ }
}
```

For unknown errors (anything not extending `RiftexError`), the boundary writes a 500 with `{ error: <message-or-fallback>, code: 'INTERNAL_ERROR' }`.

`RiftexMethodNotAllowedError` additionally sets `Allow: <comma-joined methods>`.

## Customizing with `app.onError`

```ts
app.onError((err, ctx) => {
  if (err instanceof RiftexValidationError) {
    return ctx.json({ error: err.message, fields: err.fields }, 422)
  }
  if (err instanceof RiftexUnauthorizedError) {
    return ctx.html('<h1>Login required</h1>', 401)
  }
  if (err instanceof RiftexError) throw err   // delegate to default boundary
  ctx.json({ error: 'internal' }, 500)
})
```

The handler runs before the default boundary. Return value is ignored — write the response by calling a `ctx` writer. Throwing (or re-throwing the original) hands the error back to the default boundary. If your custom handler throws a *new* error, that new error is what the default boundary sees.

`hooks.onError` listeners are observation only — they fire BEFORE the boundary writes a response and cannot swallow or replace the error. For logging, use `hooks.onError`; for response control, use `app.onError`.
