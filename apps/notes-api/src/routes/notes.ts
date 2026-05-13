// Notes CRUD. All endpoints are user-scoped: a note belonging to user B is
// invisible to user A — we return 404 rather than 403 to avoid leaking
// existence.

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { RiftexNotFoundError, RiftexValidationError, Router } from 'riftexpress'
import { hasFts5, prepared, type DB } from '../db.ts'

interface NoteRow {
  id: string
  user_id: string
  title: string
  body: string
  created_at: number
  updated_at: number
}

interface NoteDto {
  id: string
  title: string
  body: string
  tags: string[]
  created_at: number
  updated_at: number
}

const TagListSchema = z
  .array(z.string().min(1).max(40).trim())
  .max(20)
  .transform((arr) => Array.from(new Set(arr)))

const CreateNoteSchema = z.object({
  title: z.string().min(1).max(200).trim(),
  body: z.string().max(50_000).default(''),
  tags: TagListSchema.default([]),
})

const PatchNoteSchema = z
  .object({
    title: z.string().min(1).max(200).trim().optional(),
    body: z.string().max(50_000).optional(),
    tags: TagListSchema.optional(),
  })
  .refine((v) => v.title !== undefined || v.body !== undefined || v.tags !== undefined, {
    message: 'At least one of title, body, or tags must be provided',
    path: ['_'],
  })

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  tag: z.string().min(1).max(40).optional(),
  q: z.string().min(1).max(200).optional(),
})

export function notesRouter(db: DB): Router {
  const router = Router()
  const stmts = prepared(db)
  const ftsEnabled = hasFts5(db)

  // GET /api/notes — list (paginated, filterable, searchable).
  router.get('/', (ctx) => {
    const user = ctx.requireAuth()
    const parsed = ListQuerySchema.safeParse(Object.fromEntries(ctx.query))
    if (!parsed.success) {
      // Surface zod issues through the framework's validation error path.
      const fields: Record<string, string> = {}
      for (const i of parsed.error.issues) fields[i.path.join('.') || '_'] = i.message
      throw new RiftexValidationError(fields)
    }
    const { limit, offset, tag, q } = parsed.data

    let rows: NoteRow[]
    if (q) {
      rows = searchNotes(db, user.id, q, limit, offset, ftsEnabled)
    } else if (tag) {
      rows = stmts.listNotesByUserAndTag.all(user.id, tag, limit, offset) as NoteRow[]
    } else {
      rows = stmts.listNotesByUser.all(user.id, limit, offset) as NoteRow[]
    }

    return {
      items: rows.map((n) => toDto(db, n)),
      limit,
      offset,
      count: rows.length,
    }
  })

  // POST /api/notes — create.
  router.post('/', async (ctx) => {
    const user = ctx.requireAuth()
    const input = await ctx.body.json(CreateNoteSchema)
    const now = Date.now()
    const id = `note_${randomUUID()}`

    const tx = db.transaction(() => {
      stmts.insertNote.run(id, user.id, input.title, input.body, now, now)
      attachTags(db, user.id, id, input.tags)
    })
    tx()

    const row = stmts.findNoteById.get(id) as NoteRow
    ctx.json(toDto(db, row), 201)
  })

  // GET /api/notes/:id — single note. 404 if not yours or doesn't exist.
  router.get('/:id', (ctx) => {
    const user = ctx.requireAuth()
    const row = stmts.findNoteById.get(ctx.params.id) as NoteRow | undefined
    if (!row || row.user_id !== user.id) throw new RiftexNotFoundError('Note not found')
    return toDto(db, row)
  })

  // PATCH /api/notes/:id — partial update.
  router.patch('/:id', async (ctx) => {
    const user = ctx.requireAuth()
    const existing = stmts.findNoteById.get(ctx.params.id) as NoteRow | undefined
    if (!existing || existing.user_id !== user.id) throw new RiftexNotFoundError('Note not found')

    const patch = await ctx.body.json(PatchNoteSchema)

    const tx = db.transaction(() => {
      stmts.updateNote.run({
        id: existing.id,
        title: patch.title ?? existing.title,
        body: patch.body ?? existing.body,
        updated_at: Date.now(),
      })
      if (patch.tags !== undefined) {
        stmts.detachTagsForNote.run(existing.id)
        attachTags(db, user.id, existing.id, patch.tags)
      }
    })
    tx()

    const updated = stmts.findNoteById.get(existing.id) as NoteRow
    return toDto(db, updated)
  })

  // DELETE /api/notes/:id — soft 404 if it isn't theirs (don't leak existence).
  router.delete('/:id', (ctx) => {
    const user = ctx.requireAuth()
    const existing = stmts.findNoteById.get(ctx.params.id) as NoteRow | undefined
    if (!existing || existing.user_id !== user.id) throw new RiftexNotFoundError('Note not found')
    stmts.deleteNote.run(existing.id)
    ctx.status(204)
    // Returning undefined here triggers the framework's 204-no-content rule.
  })

  return router
}

// ───── helpers ────────────────────────────────────────────────────────────

function toDto(db: DB, row: NoteRow): NoteDto {
  const tags = (prepared(db).listTagsForNote.all(row.id) as { name: string }[]).map((t) => t.name)
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    tags,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function attachTags(db: DB, userId: string, noteId: string, names: readonly string[]): void {
  const stmts = prepared(db)
  for (const name of names) {
    const tagId = `tag_${randomUUID()}`
    stmts.upsertTag.run(tagId, userId, name)
    const existing = stmts.findTagByName.get(userId, name) as { id: string } | undefined
    if (existing) stmts.attachTag.run(noteId, existing.id)
  }
}

function searchNotes(
  db: DB,
  userId: string,
  q: string,
  limit: number,
  offset: number,
  fts: boolean,
): NoteRow[] {
  if (fts) {
    // MATCH expects FTS5 query syntax. We sanitize user input to a single
    // prefix-match phrase to avoid syntax errors from unbalanced quotes etc.
    const term = q.replace(/["*]/g, ' ').trim()
    if (!term) return []
    const sql = `
      SELECT n.id, n.user_id, n.title, n.body, n.created_at, n.updated_at
        FROM notes_fts f
        JOIN notes n ON n.rowid = f.rowid
       WHERE notes_fts MATCH ? AND n.user_id = ?
       ORDER BY n.updated_at DESC
       LIMIT ? OFFSET ?`
    return db.prepare(sql).all(`${term}*`, userId, limit, offset) as NoteRow[]
  }

  const like = `%${q.replace(/[%_]/g, (c) => '\\' + c)}%`
  return db
    .prepare(
      `SELECT id, user_id, title, body, created_at, updated_at
         FROM notes
        WHERE user_id = ? AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')
        ORDER BY updated_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(userId, like, like, limit, offset) as NoteRow[]
}
