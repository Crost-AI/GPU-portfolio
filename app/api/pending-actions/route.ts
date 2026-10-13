import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveBrowserPrincipal } from '@/lib/pending-actions/browser-principal'
import { listAgentRuns, listPendingActions, PendingActionServiceError } from '@/lib/pending-actions/service'

/**
 * The fund's pending-action queue.
 *
 * A queue spans domains, so the route itself is ungated (UNGATED_ROUTES) and each ROW is filtered
 * by whether the caller can READ its domain; approving still requires WRITE. That filter used to
 * be written out again here, beside the copy in the service — two implementations of one rule, one
 * of which would eventually stop matching. Now there is the one.
 *
 * Paginated, unlike the version this replaces, which selected every pending row. The client walks
 * the cursor to the end.
 *
 * `?view=runs` lists the latest runs that were applied or stopped partway (lib/agent/run-action.ts),
 * with their per-step results, so the Approvals page can show what each did and offer Undo. Same
 * filter: every step's domain, and the caller's entities.
 */
export async function GET(req: Request) {
  const admin = createAdminClient()
  const principal = await resolveBrowserPrincipal(admin)
  if (principal instanceof NextResponse) return principal

  const url = new URL(req.url)
  const cursor = url.searchParams.get('cursor')

  try {
    if (url.searchParams.get('view') === 'runs') {
      return NextResponse.json(await listAgentRuns(admin, principal, 20))
    }
    const { actions, nextCursor } = await listPendingActions(admin, principal, { limit: 50, cursor })
    return NextResponse.json({ actions, nextCursor })
  } catch (error) {
    if (error instanceof PendingActionServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    console.error('[pending-actions] list failed', error)
    return NextResponse.json({ error: 'The queue could not be loaded.' }, { status: 500 })
  }
}
