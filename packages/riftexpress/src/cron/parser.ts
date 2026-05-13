/**
 * 5-field crontab parser + "next fire time" calculator.
 *
 * Grammar (per field):
 *   - `*`              every value
 *   - `N`              literal
 *   - `N-M`            inclusive range
 *   - `* / S` or `N-M / S`  step
 *   - `A,B,C`          list (each entry can be any of the above)
 *
 * Supported field ranges:
 *   minute  0-59
 *   hour    0-23
 *   dom     1-31
 *   month   1-12, or 3-letter names jan|feb|...|dec
 *   dow     0-6  (sunday=0), or 3-letter names sun|mon|...|sat
 *
 * Explicitly NOT supported (would need a different parser):
 *   - 6-field syntax with seconds
 *   - L (last day-of-month), W (weekday), # (nth-of-month)
 *   - Predefined macros (@hourly, @daily, ...)
 *
 * Day-of-month vs day-of-week conflict resolution: when BOTH `dom` and
 * `dow` are restricted (i.e. neither is `*`), the cron fires when EITHER
 * matches (this is the historical Vixie-cron behavior). When only one is
 * restricted, only that one matters. This is what every other production
 * cron implementation does and what users expect.
 */

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}

interface FieldSpec {
  min: number
  max: number
  /** Optional name → number map (months, weekdays). */
  names?: Record<string, number>
}

const FIELDS: { minute: FieldSpec; hour: FieldSpec; dom: FieldSpec; month: FieldSpec; dow: FieldSpec } = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dom: { min: 1, max: 31 },
  month: { min: 1, max: 12, names: MONTH_NAMES },
  dow: { min: 0, max: 6, names: DOW_NAMES },
}

/** Parsed match-set. `Set<number>` of all valid integers per field. */
export interface CronMatch {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  /** Was the original `dom` field `*`? Used for dom/dow conflict resolution. */
  domIsWild: boolean
  /** Was the original `dow` field `*`? */
  dowIsWild: boolean
}

/**
 * Parse a 5-field crontab spec into a {@link CronMatch}. Throws on any
 * malformed input — out-of-range, wrong field count, garbage characters.
 */
export function parseCronSpec(spec: string): CronMatch {
  if (typeof spec !== 'string') {
    throw new Error(`riftexpress: cron spec must be a string (got ${typeof spec})`)
  }
  const trimmed = spec.trim()
  if (trimmed === '') throw new Error('riftexpress: cron spec is empty')

  const fields = trimmed.split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(
      `riftexpress: cron spec must have exactly 5 fields (got ${fields.length}: "${spec}"). ` +
      `Six-field specs with seconds are not supported in v0.0.1.`,
    )
  }

  const [minuteF, hourF, domF, monthF, dowF] = fields as [string, string, string, string, string]
  return {
    minute: parseField(minuteF, FIELDS.minute, 'minute'),
    hour: parseField(hourF, FIELDS.hour, 'hour'),
    dom: parseField(domF, FIELDS.dom, 'day-of-month'),
    month: parseField(monthF, FIELDS.month, 'month'),
    dow: parseField(dowF, FIELDS.dow, 'day-of-week'),
    domIsWild: domF === '*',
    dowIsWild: dowF === '*',
  }
}

function parseField(field: string, spec: FieldSpec, label: string): Set<number> {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    expandPart(part, spec, label, out)
  }
  if (out.size === 0) {
    throw new Error(`riftexpress: cron field "${label}" produced no matches ("${field}")`)
  }
  return out
}

function expandPart(part: string, spec: FieldSpec, label: string, out: Set<number>): void {
  if (part === '') throw new Error(`riftexpress: empty cron sub-expression in "${label}"`)

  // Step: optional. Either `*/N`, `A-B/N`, or `A/N` (treated as `A-max/N`).
  let step = 1
  let body = part
  const slashIdx = part.indexOf('/')
  if (slashIdx >= 0) {
    body = part.slice(0, slashIdx)
    const stepStr = part.slice(slashIdx + 1)
    if (!/^\d+$/.test(stepStr)) {
      throw new Error(`riftexpress: cron step in "${label}" must be a positive integer ("${part}")`)
    }
    step = parseInt(stepStr, 10)
    if (step <= 0) {
      throw new Error(`riftexpress: cron step in "${label}" must be > 0 ("${part}")`)
    }
  }

  let lo: number
  let hi: number
  if (body === '*') {
    lo = spec.min
    hi = spec.max
  } else if (body.includes('-')) {
    const [aStr, bStr] = body.split('-')
    const a = parseAtom(aStr ?? '', spec, label)
    const b = parseAtom(bStr ?? '', spec, label)
    if (a > b) {
      throw new Error(`riftexpress: cron range "${body}" in "${label}" is reversed (${a} > ${b})`)
    }
    lo = a
    hi = b
  } else {
    const v = parseAtom(body, spec, label)
    if (slashIdx >= 0) {
      // `N/S` form → `N-max/S`
      lo = v
      hi = spec.max
    } else {
      lo = hi = v
    }
  }

  if (lo < spec.min || hi > spec.max) {
    throw new Error(
      `riftexpress: cron value out of range in "${label}" — got ${lo}..${hi}, allowed ${spec.min}..${spec.max}`,
    )
  }

  for (let i = lo; i <= hi; i += step) out.add(i)
}

function parseAtom(atom: string, spec: FieldSpec, label: string): number {
  if (atom === '') throw new Error(`riftexpress: empty cron atom in "${label}"`)
  if (/^-?\d+$/.test(atom)) {
    const n = parseInt(atom, 10)
    if (n < 0) {
      throw new Error(`riftexpress: cron value in "${label}" must be non-negative ("${atom}")`)
    }
    return n
  }
  if (spec.names) {
    const lower = atom.toLowerCase()
    if (lower in spec.names) return spec.names[lower]!
  }
  throw new Error(`riftexpress: cron atom "${atom}" in "${label}" is not a number or known name`)
}

// ─── Next-fire calculation ──────────────────────────────────────────────────

/**
 * Given a parsed {@link CronMatch}, find the next moment >= `from` that
 * matches the spec, in the given IANA timezone. Returns `null` if none
 * within ~5 years (defensive against pathological specs).
 *
 * Algorithm: walk forward minute-by-minute with smart skipping. We start
 * one minute past `from` (cron fires at the START of each minute and we
 * never want to re-fire the same slot back-to-back).
 *
 * Timezone handling:
 *   - For `'UTC'` we use direct UTC accessors — fast path.
 *   - For other zones we call `Intl.DateTimeFormat` to get the wall-clock
 *     fields in that zone for each candidate. This relies on Node's bundled
 *     ICU data; full-icu Node ships with a complete tz database.
 *
 * DST: by walking minute-by-minute on the UTC timeline and reading the
 * wall-clock fields per-step, we naturally skip the "spring forward" gap
 * (those minutes simply don't exist in the local clock so they can't match
 * the user's local-time spec) and double-fire on "fall back" (the wall
 * clock visits 1:30am twice; we fire each time). The latter matches Vixie
 * cron's documented behavior — users wanting strict once-per-day semantics
 * should pin their spec to UTC.
 */
export function nextFireFrom(match: CronMatch, from: Date, timezone = 'UTC'): Date | null {
  // Start at the next whole minute strictly after `from`.
  const start = new Date(from.getTime() + 1)
  start.setUTCSeconds(0, 0)
  // If the rounding above happened to put us at-or-before `from`, bump.
  if (start.getTime() <= from.getTime()) {
    start.setTime(start.getTime() + 60_000)
    start.setUTCSeconds(0, 0)
  }

  // Cap the search to ~5 years in case the spec matches nothing reachable.
  const maxIterations = 5 * 366 * 24 * 60
  const candidate = start
  const reader = timezone === 'UTC' ? readUtc : makeIntlReader(timezone)

  for (let i = 0; i < maxIterations; i++) {
    const wall = reader(candidate)
    if (matchesWall(match, wall)) return new Date(candidate.getTime())
    // Step forward one minute.
    candidate.setTime(candidate.getTime() + 60_000)
  }
  return null
}

interface WallClock {
  minute: number
  hour: number
  dom: number
  month: number   // 1-12
  dow: number     // 0=sunday
}

function matchesWall(m: CronMatch, w: WallClock): boolean {
  if (!m.minute.has(w.minute)) return false
  if (!m.hour.has(w.hour)) return false
  if (!m.month.has(w.month)) return false
  // Vixie-cron dom/dow OR semantics: if BOTH are restricted, either match
  // is sufficient. If only one is restricted, only it matters.
  const domOk = m.dom.has(w.dom)
  const dowOk = m.dow.has(w.dow)
  if (m.domIsWild && m.dowIsWild) {
    // Both wild → both sets are full → both ok (above) → fall through to true.
    if (!domOk || !dowOk) return false
  } else if (m.domIsWild) {
    if (!dowOk) return false
  } else if (m.dowIsWild) {
    if (!domOk) return false
  } else {
    if (!domOk && !dowOk) return false
  }
  return true
}

function readUtc(d: Date): WallClock {
  return {
    minute: d.getUTCMinutes(),
    hour: d.getUTCHours(),
    dom: d.getUTCDate(),
    month: d.getUTCMonth() + 1,
    dow: d.getUTCDay(),
  }
}

/**
 * Build a wall-clock reader for a non-UTC timezone using `Intl.DateTimeFormat`.
 * The reader is reusable (we cache the formatter).
 */
function makeIntlReader(timezone: string): (d: Date) => WallClock {
  let fmt: Intl.DateTimeFormat
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    })
  } catch {
    throw new Error(
      `riftexpress: invalid cron timezone "${timezone}". ` +
      `Use a valid IANA zone (e.g. "America/Los_Angeles") or "UTC".`,
    )
  }
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

  return (d: Date): WallClock => {
    const parts = fmt.formatToParts(d)
    let minute = 0, hour = 0, dom = 1, month = 1, dow = 0
    for (const p of parts) {
      switch (p.type) {
        case 'minute': minute = parseInt(p.value, 10); break
        case 'hour': {
          // Intl returns "24" at midnight in en-US hour12:false on some Node versions; normalize.
          const h = parseInt(p.value, 10)
          hour = h === 24 ? 0 : h
          break
        }
        case 'day': dom = parseInt(p.value, 10); break
        case 'month': month = parseInt(p.value, 10); break
        case 'weekday': dow = dowMap[p.value] ?? 0; break
      }
    }
    return { minute, hour, dom, month, dow }
  }
}
