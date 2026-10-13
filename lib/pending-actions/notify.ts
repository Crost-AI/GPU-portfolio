// Telling the fund's admins that a change is waiting on them.
//
// A member who stages a change they may approve themselves confirms it in the same conversation;
// nobody else needs to hear about it. An admin-only change staged by a member is different: it
// waits on someone who is not in that conversation, and until now they found it only by opening
// Approvals. So the admins get an email saying what is waiting, from whom, and that they can
// approve it from their own chat or the app.
//
// Best-effort: no outbound provider means no email, and a failed send never fails the staging.

import type { SupabaseClient } from '@supabase/supabase-js'
import { notifyFundAdmins } from '@/lib/lp-onboarding-notify'
import { siteOrigin } from '@/lib/site-links'

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

export async function notifyAdminsOfStagedChange(admin: SupabaseClient, args: {
  fundId: string
  /** What only an admin can do, in the admin-only list's words ("add a commitment"). */
  label: string
  summary: string
  requesterId: string | null
  origin?: string | null
}): Promise<number> {
  try {
    let who = 'A member'
    if (args.requesterId) {
      const { data } = await admin.auth.admin.getUserById(args.requesterId)
      const u = data?.user
      if (u) who = (u.user_metadata?.full_name as string | undefined) || u.email || who
    }
    const link = `${(args.origin || siteOrigin()).replace(/\/$/, '')}/pending-actions`
    const html =
      `<p>${esc(who)} asked to <strong>${esc(args.label)}</strong>, which needs an admin's approval.</p>` +
      `<p>${esc(args.summary)}</p>` +
      `<p>Nothing has changed yet. You can approve or reject it from your own Claude or ChatGPT (ask it to list pending actions), ` +
      `or <a href="${esc(link)}">in the app under Approvals</a>.</p>`
    return await notifyFundAdmins(admin, args.fundId, `Waiting for your approval: ${args.label}`, html)
  } catch (e) {
    console.error('[pending-actions notify]', e instanceof Error ? e.message : e)
    return 0
  }
}
