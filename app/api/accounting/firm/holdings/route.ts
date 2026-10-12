import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts). Management companies are included only for a
// caller who holds `management_company`, and each entity only where entity access allows it — the
// same two rules /api/accounting/firm applies to its list.
import { assertReadAccess } from '@/lib/api-helpers'
import { loadAccessContext, hasAccess } from '@/lib/access/effective'
import { canSeeVehicle } from '@/lib/access/scope'
import { loadFirmHoldings } from '@/lib/accounting/holdings-firm'
import { dbError } from '@/lib/api-error'

// GET — every holding across entities, one row per company, with who holds it. A firm-wide section landing.
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
    return NextResponse.json(await loadFirmHoldings(admin, gate.fundId, { includeManco, visible: id => canSeeVehicle(ctx, id) }))
  } catch (e) {
    return dbError(e as Error, 'firm-holdings')
  }
}
