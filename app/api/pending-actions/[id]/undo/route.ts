import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveBrowserPrincipal } from '@/lib/pending-actions/browser-principal'
import { PendingActionServiceError, undoAgentRun } from '@/lib/pending-actions/service'

// A run can have created many entries and transactions; each is voided or deleted in turn.
export const maxDuration = 300

/**
 * Undo what an approved run created (lib/agent/run-undo.ts), from the Approvals page. Held to the
 * same rule as approving it: write in every step's domain, re-checked live by the service, which
 * also claims the row so two clicks cannot both run it. Each entry or transaction reports its own
 * outcome, and anything that cannot be safely undone is said so rather than attempted.
 */
export async function POST(_req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const admin = createAdminClient()
  const principal = await resolveBrowserPrincipal(admin)
  if (principal instanceof NextResponse) return principal

  try {
    const result = await undoAgentRun(admin, principal, params.id)
    return NextResponse.json({ ok: true, replayed: result.replayed, action: result.action })
  } catch (error) {
    if (error instanceof PendingActionServiceError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status })
    }
    console.error('[pending-actions] undo failed', error)
    return NextResponse.json({ ok: false, error: 'The run could not be undone.' }, { status: 500 })
  }
}
