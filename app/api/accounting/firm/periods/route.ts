import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts). Management companies are included only for a
// caller who holds `management_company`, and each entity only where entity access allows it — the
// same two rules /api/accounting/firm applies to its list.
import { assertReadAccess } from '@/lib/api-helpers'
import { loadAccessContext, hasAccess } from '@/lib/access/effective'
import { canSeeVehicle } from '@/lib/access/scope'
import { loadCloseGrid } from '@/lib/accounting/close-grid'
import { dbError } from '@/lib/api-error'

// GET — the close calendar — every entity's recent quarter-ends, closed or not. A firm-wide section landing.
export async function GET() {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const ctx = await loadAccessContext(admin, gate.fundId, user.id, gate.role)
  const includeManco = hasAccess(ctx, 'management_company', 'read')
  try {
    return NextResponse.json(await loadCloseGrid(admin, gate.fundId, { includeManco, visible: id => canSeeVehicle(ctx, id) }))
  } catch (e) {
    return dbError(e as Error, 'firm-close-grid')
  }
}
