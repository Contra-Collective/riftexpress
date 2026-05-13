# `riftexpress-cli`

Project scaffolder. Zero runtime dependencies — only Node built-ins. Lives in [`packages/riftexpress-cli`](../../packages/riftexpress-cli).

## Install

```sh
npm install -g riftexpress-cli
```

Or run on demand without installing:

```sh
npx riftexpress-cli new my-api
```

**Requires Node 22+** — the CLI runs `.ts` sources via `--experimental-strip-types`.

## Usage

```sh
riftex new <name> [--bun] [--minimal] [--force]
riftex routes
riftex --version
riftex --help
```

### `riftex new <name>`

Scaffold a new RiftExpress project at `./<name>`.

| Flag | Effect |
|---|---|
| `--minimal` | Bare hello-world template (10-line `src/index.ts`). |
| `--bun` | Bun.serve adapter template (`riftexpress-bun`). |
| `--force` | Overwrite an existing directory at the target path. |

Without `--bun` or `--minimal`, the default template is used.

Templates available (in `packages/riftexpress-cli/src/templates/`):

- `default` — full skeleton: `package.json`, `tsconfig.json`, `.gitignore`, `src/index.ts`, `README.md`.
- `minimal` — same skeleton with a tiny hello-world `src/index.ts`.
- `bun` — Bun.serve variant wired through `BunAdapter`.

Argv is parsed by hand — `--key` and `-k` are both flag-only (no values consumed), and the first non-flag argument is the command, with the rest accumulated as positionals.

### `riftex routes`

Placeholder in v0.0.1 — prints a "not implemented" notice. Will print the registered route table once the route-introspection API ships.

### `riftex --version` / `riftex -v`

Prints the CLI version (read from its own `package.json`).

### `riftex --help` / `riftex -h`

Prints the help banner.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | Scaffold failed (filesystem error, target exists without `--force`, etc.). |
| `2` | Argv error — unknown command, missing project name. |

## Examples

```sh
riftex new my-api                      # default template
riftex new my-bun-api --bun            # Bun.serve adapter
riftex new tiny --minimal              # minimal hello-world
riftex new my-api --force              # overwrite existing dir
```

After scaffolding, the CLI prints `Next steps:` with the conventional three-line `cd / npm install / npm run dev` instructions.
