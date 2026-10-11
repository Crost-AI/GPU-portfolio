import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertAdminAccess } from '@/lib/api-helpers'
import { loadAccessContext } from '@/lib/access/effective'
import { computeSetupProgress, loadSetupFacts } from '@/lib/onboarding/progress'

/**
 * The getting-started count for the "Finish setting up" banner on /start and /dashboard — both
 * client pages, so they cannot take it as server props.
 *
 * Admin-only (ROUTE_DOMAINS: `admin`), checked again here. Returns step keys and statuses only —
 * the banner needs a count, not the details — plus the caller's own user id, which keys their
 * per-browser skip list.
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const gate = await assertAdminAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const access = await loadAccessContext(admin, gate.fundId, user.id, gate.role)
  const progress = computeSetupProgress(await loadSetupFacts(admin, gate.fundId, access))

  return NextResponse.json({
    userId: user.id,
    done: progress.done,
    total: progress.total,
    complete: progress.complete,
    steps: progress.sections.flatMap(s => s.steps.map(st => ({ key: st.key, status: st.status }))),
  })
}
