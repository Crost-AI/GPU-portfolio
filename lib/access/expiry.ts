// Access that ends on a date (fund_members.access_expires_at, 20261012160000_member_access_expiry.sql).
//
// Two halves. `access_context` stops resolving an expired membership the moment it passes, so every
// gated surface refuses at once. The cron below then removes the membership, which is what closes
// the paths that read `fund_members` directly (RLS policies the Data API runs).

import type { SupabaseClient } from '@supabase/supabase-js'
import { logActivity } from '@/lib/activity'

/** Why this date cannot be set on this member, or null when it can. `expiresAt` null clears it. */
export function accessExpiryProblem(args: {
  target: { role: string } | null
  expiresAt: unknown
  now?: Date
}): { error: string; status: number } | null {
  if (!args.target) return { error: 'Not a member of this fund', status: 404 }
  if (args.expiresAt === null) return null
  // Admins never expire: a fund whose last admin timed out would have nobody to let anyone back in.
  if (args.target.role === 'admin') return { error: 'An admin’s access cannot have an end date.', status: 400 }
  if (args.target.role === 'viewer') return { error: 'The demo account’s access cannot have an end date.', status: 400 }
  if (typeof args.expiresAt !== 'string' || Number.isNaN(Date.parse(args.expiresAt))) {
    return { error: 'accessExpiresAt must be a date, or null to clear it.', status: 400 }
  }
  if (Date.parse(args.expiresAt) <= (args.now ?? new Date()).getTime()) {
    return { error: 'The end date must be in the future. To end access now, remove the member.', status: 400 }
  }
  return null
}

/** A date-only value ("2026-12-31") ends at the end of that day UTC, not its first second. */
export function normalizeExpiry(raw: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:59.999Z` : new Date(raw).toISOString()
}

/**
 * Remove every non-admin membership whose end date has passed. The same as an admin removing
 * them: the membership and its entity grants go; per-area grants stay as history, as they do on a
 * manual removal. Returns what was removed.
 */
export async function endExpiredAccess(
  admin: SupabaseClient,
  now: Date = new Date(),
): Promise<{ fundId: string; userId: string }[]> {
  const { data, error } = await (admin as any)
    .from('fund_members')
    .select('id, fund_id, user_id, role, access_expires_at')
    .not('access_expires_at', 'is', null)
    .lte('access_expires_at', now.toISOString())
    .neq('role', 'admin')
  // Before the migration the column does not exist; nothing can have expired.
  if (error) return []

  const ended: { fundId: string; userId: string }[] = []
  for (const m of (data ?? []) as { id: string; fund_id: string; user_id: string; access_expires_at: string }[]) {
    const { error: delErr } = await (admin as any).from('fund_members').delete().eq('id', m.id)
    if (delErr) continue
    await (admin as any).from('fund_member_vehicles').delete().eq('fund_id', m.fund_id).eq('user_id', m.user_id)
    // Logged against the member whose access ended: there is no admin behind a date passing.
    logActivity(admin, m.fund_id, m.user_id, 'access.expired', { member: m.user_id, expiredAt: m.access_expires_at })
    ended.push({ fundId: m.fund_id, userId: m.user_id })
  }
  return ended
}
