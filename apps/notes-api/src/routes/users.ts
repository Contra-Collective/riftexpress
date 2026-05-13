// User signup, token issuance, and the authenticated `me` endpoint.

import { randomUUID, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { RiftexBadRequestError, Router } from 'riftexpress'
import { prepared, type DB } from '../db.ts'
import type { AuthUser } from '../auth.ts'

const SignupSchema = z.object({
  email: z.string().email().max(254),
  display_name: z.string().min(1).max(80).trim(),
})

const TokenSchema = z.object({
  email: z.string().email().max(254),
})

function publicUser(u: AuthUser): {
  id: string
  email: string
  display_name: string
  created_at: number
} {
  return {
    id: u.id,
    email: u.email,
    display_name: u.display_name,
    created_at: u.created_at,
  }
}

export function usersRouter(db: DB): Router {
  const router = Router()
  const stmts = prepared(db)

  // POST /api/users/signup — create an account. Returns the user + a fresh token.
  router.post('/signup', async (ctx) => {
    const input = await ctx.body.json(SignupSchema)

    const existing = stmts.findUserByEmail.get(input.email) as AuthUser | undefined
    if (existing) throw new RiftexBadRequestError('Email already registered')

    const id = `usr_${randomUUID()}`
    const now = Date.now()
    stmts.insertUser.run(id, input.email, input.display_name, now)

    const token = newToken()
    stmts.insertToken.run(token, id, now)

    ctx.json(
      {
        user: { id, email: input.email, display_name: input.display_name, created_at: now },
        token,
      },
      201,
    )
  })

  // POST /api/users/tokens — issue a new token for an existing user.
  // Real apps would gate this on a password / OTP / OAuth flow; this is a
  // demo, so possession of the email is enough.
  router.post('/tokens', async (ctx) => {
    const input = await ctx.body.json(TokenSchema)
    const user = stmts.findUserByEmail.get(input.email) as AuthUser | undefined
    if (!user) throw new RiftexBadRequestError('No account for that email')

    const token = newToken()
    stmts.insertToken.run(token, user.id, Date.now())
    ctx.json({ token, user: publicUser(user) }, 201)
  })

  // GET /api/users/me — protected. Returns the caller's profile.
  router.get('/me', (ctx) => {
    const user = ctx.requireAuth()
    return { user: publicUser(user) }
  })

  return router
}

function newToken(): string {
  // 32 random bytes, url-safe base64. ~256 bits of entropy.
  return `tok_${randomBytes(32).toString('base64url')}`
}
