// Shared CRON_SECRET check for app/api/cron/*.
//
// `authorization !== \`Bearer ${secret}\`` is a short-circuiting string compare: its running time
// leaks how long a guessed prefix matched. Both sides are hashed to fixed-length digests first so
// timingSafeEqual always compares equal-length buffers (and the secret's length doesn't leak
// either). Fail-closed: an unset CRON_SECRET refuses every caller — the old "if secret then check"
// pattern opened workers to anyone on previews and misconfigured deployments.

import { createHash, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest()

/** Constant-time `header === \`Bearer ${secret}\``. False when either is missing or empty. */
export function isValidCronAuthorization(header: string | null | undefined, secret: string | null | undefined): boolean {
  if (!secret || !header) return false
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`))
}

/** The response to send instead of running the cron, or null when the caller is authorized. */
export function cronAuthDenial(req: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET
  if (!secret) return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 })
  if (!isValidCronAuthorization(req.headers.get('authorization'), secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}
