// Health-check router. Mounted at /api/health.
// Returns 200 with structured status; 503 if the DB ping fails so load
// balancers can deroute the instance.

import { Router } from 'riftexpress'
import type { DB } from '../db.ts'

const VERSION = '0.0.1'
const startedAt = Date.now()

export function healthRouter(db: DB): Router {
  const router = Router()

  router.get('/', (ctx) => {
    let dbStatus: 'up' | 'down' = 'up'
    try {
      db.prepare('SELECT 1').get()
    } catch {
      dbStatus = 'down'
    }

    const ok = dbStatus === 'up'
    ctx.json(
      {
        ok,
        db: dbStatus,
        uptime: Math.round((Date.now() - startedAt) / 1000),
        version: VERSION,
      },
      ok ? 200 : 503,
    )
  })

  return router
}
