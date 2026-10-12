import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts). Management companies join the queue only for a
// caller who holds `management_company`, and each entity only where entity access allows it — the
// same two rules /api/accounting/firm applies to its list.
import { assertReadAccess } from '@/lib/api-helpers'
import { loadAccessContext, hasAccess } from '@/lib/access/effective'
import { canSeeVehicle } from '@/lib/access/scope'
import { loadFirmBank } from '@/lib/accounting/bank-firm'
import { dbError } from '@/lib/api-error'

// GET — every open bank row across the entities the caller may see, with a summary per entity.
// The firm-wide bank landing; the rows are booked on each entity's own bank page.
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
    return NextResponse.json(await loadFirmBank(admin, gate.fundId, { includeManco, visible: id => canSeeVehicle(ctx, id) }))
  } catch (e) {
    return dbError(e as Error, 'firm-bank')
  }
}
