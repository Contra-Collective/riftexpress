# Errors

Every framework-emitted error extends `IngeniumError`. The default error boundary serializes any `IngeniumError` as `{ error, code, fields? }` with the matching HTTP status. Anything else becomes a 500.

```ts
import {
  IngeniumError,
  IngeniumNotFoundError,
  IngeniumUnauthorizedError,
  IngeniumMethodNotAllowedError,
  IngeniumPayloadTooLargeError,
  IngeniumValidationError,
  IngeniumBadRequestError,
} from 'ingenium'
```

## `IngeniumError` — base class

```ts
class IngeniumError extends Error {
  readonly statusCode: number
  readonly code: string                  // UPPER_SNAKE_CASE
  readonly cause?: unknown
  constructor(statusCode: number, code: string, message: string, cause?: unknown)
}
```

`name` is set from the constructor (`new.target.name`) so subclasses identify themselves correctly in stack traces. Use this base when defining your own framework-aware error classes — anything extending it is recognized by the default boundary.

## Built-in subclasses

### `IngeniumNotFoundError` — 404

```ts
class IngeniumNotFoundError extends IngeniumError {
  constructor(message?: string)  // default 'Not Found'
}
// statusCode 404, code 'NOT_FOUND'
```

Thrown by the framework when no route matches the request path. Override the message to expose more context (`new IngeniumNotFoundError('User not found')`).

### `IngeniumUnauthorizedError` — 401

```ts
class IngeniumUnauthorizedError extends IngeniumError {
  constructor(message?: string)  // default 'Unauthorized'
}
// statusCode 401, code 'UNAUTHORIZED'
```

Throw from auth middleware or decorators when the request lacks valid credentials.

### `IngeniumMethodNotAllowedError` — 405

```ts
class IngeniumMethodNotAllowedError extends IngeniumError {
  readonly allowed: readonly string[]
  constructor(allowed: readonly string[], message?: string)  // default 'Method Not Allowed'
}
// statusCode 405, code 'METHOD_NOT_ALLOWED'
```

Thrown when a route path matched but no handler is registered for the request's method. The default boundary writes the `Allow` response header from `allowed` automatically (`'GET, POST, OPTIONS'`-style).

### `IngeniumPayloadTooLargeError` — 413

```ts
class IngeniumPayloadTooLargeError extends IngeniumError {
  constructor(message?: string)  // default 'Payload Too Large'
}
// statusCode 413, code 'PAYLOAD_TOO_LARGE'
```

Thrown by `ctx.body.json/text/urlencoded/buffer/multipart` when the body exceeds `maxBytes`, or by `ctx.body.multipart` when a single file exceeds `maxFileSize`.

### `IngeniumValidationError` — 422

```ts
class IngeniumValidationError extends IngeniumError {
  readonly fields: Record<string, string>
  constructor(fields: Record<string, string>, message?: string)  // default 'Validation Failed'
}
// statusCode 422, code 'VALIDATION_FAILED'
```

Thrown by `ctx.body.json(schema)` when the parsed value fails validation. Each entry in `fields` maps a dot-joined field path to a human-readable message; the empty path becomes `'_'`. The `fields` map is included in the default boundary's serialized response.

### `IngeniumBadRequestError` — 400

```ts
class IngeniumBadRequestError extends IngeniumError {
  constructor(message?: string, cause?: unknown)  // default 'Bad Request'
}
// statusCode 400, code 'BAD_REQUEST'
```

Thrown for malformed input — invalid JSON, body already consumed, missing body, malformed multipart, missing `Content-Type` for multipart, etc.

## Default boundary

```jsonc
// status: <IngeniumError.statusCode>
// content-type: application/json; charset=utf-8
{
  "error": "<message>",
  "code":  "<CODE>",
  "fields": { /* present only on IngeniumValidationError */ }
}
```

For unknown errors (anything not extending `IngeniumError`), the boundary writes a 500 with `{ error: <message-or-fallback>, code: 'INTERNAL_ERROR' }`.

`IngeniumMethodNotAllowedError` additionally sets `Allow: <comma-joined methods>`.

## Customizing with `app.onError`

```ts
app.onError((err, ctx) => {
  if (err instanceof IngeniumValidationError) {
    return ctx.json({ error: err.message, fields: err.fields }, 422)
  }
  if (err instanceof IngeniumUnauthorizedError) {
    return ctx.html('<h1>Login required</h1>', 401)
  }
  if (err instanceof IngeniumError) throw err   // delegate to default boundary
  ctx.json({ error: 'internal' }, 500)
})
```

The handler runs before the default boundary. Return value is ignored — write the response by calling a `ctx` writer. Throwing (or re-throwing the original) hands the error back to the default boundary. If your custom handler throws a *new* error, that new error is what the default boundary sees.

`hooks.onError` listeners are observation only — they fire BEFORE the boundary writes a response and cannot swallow or replace the error. For logging, use `hooks.onError`; for response control, use `app.onError`.

## Dev-mode warnings

The framework emits `process.emitWarning` for common misuse patterns when `NODE_ENV !== 'production'`. The check is gated by a module-level `const IS_DEV` so V8 dead-code eliminates the diagnostic in production builds — zero hot-path cost.

| Warning name | Condition | Once per process? |
|---|---|---|
| `IngeniumDoubleWriteWarning` | A `ctx.json/text/html/send/redirect/stream` writer was called after the response was already written (`ctx._written === true`). The second call wins; use `return` after the first write to short-circuit. | No — fires on every double write so each occurrence is observable. |
| `IngeniumTrustProxyWarning` | `ctx.ip` / `ctx.ips` / `ctx.protocol` / `ctx.hostname` was read with `trustProxy: false` while the request carries `X-Forwarded-For`. Hints to configure `trustProxy` if running behind a reverse proxy. | Yes — first occurrence only. |
| `IngeniumResponseObjectWarning` | A handler returned a fetch-style global `Response` object. Ingenium handlers return plain values or call `ctx.json/...`. The Response is ignored and the request falls through to 204. | Yes — first occurrence only. |
| `IngeniumLateWriteWarning` | A `requestTimeoutMs`-orphaned handler eventually wrote to a context that has since been recycled (see ADR 0004). The write is swallowed. | No — every late write is observable. |

These warnings are non-fatal; the request continues. They surface as warnings (not errors) so existing test runners and process listeners can catch them with `process.on('warning', ...)`.

Hard misuse — situations where the framework can't safely continue — throws instead:

- `app.listen()` on an app that's already listening throws `TypeError("app.listen(): this app is already listening...")`. Close the existing server first.
- `expressCompat(knownBroken)` throws at registration time for the four broken middleware (`multer`, `express-session`, `compression`, `body-parser`) — opt out with `{ allowKnownBroken: true }` to get a warning instead.
