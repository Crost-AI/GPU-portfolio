import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts). The family's members are the entities the
// caller may see, management companies only with `management_company` — so a scoped caller gets
// the part of the family they can see, and the intercompany pairs only between those.
import { assertReadAccess } from '@/lib/api-helpers'
import { loadAccessContext, hasAccess } from '@/lib/access/effective'
import { canSeeVehicle } from '@/lib/access/scope'
import { listFirmEntities } from '@/lib/accounting/firm-entities'
import { loadFamilyIntercompany } from '@/lib/accounting/intercompany-firm'
import { loadVehicleGroups } from '@/lib/vehicle-groups-server'
import { dbError } from '@/lib/api-error'

// GET ?groupId=<vehicle_groups.id> — one entity group (a "family": a fund, its GP, its manco):
// its name, its members, and the intercompany balances between them, from both sides' books.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const groupId = req.nextUrl.searchParams.get('groupId')
  if (!groupId) return NextResponse.json({ error: 'groupId is required' }, { status: 400 })

  const ctx = await loadAccessContext(admin, gate.fundId, user.id, gate.role)
  try {
    // The groups payload is already narrowed to what this caller may see, and is fund-scoped.
    const payload = await loadVehicleGroups(admin, gate.fundId, ctx)
    const group = payload.groups.find(g => g.id === groupId)
    if (!group) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const memberIds = new Set(payload.assignments.filter(a => a.groupId === groupId).map(a => a.vehicleId))
    const members = (await listFirmEntities(admin, gate.fundId, {
      includeManco: hasAccess(ctx, 'management_company', 'read'),
      visible: id => canSeeVehicle(ctx, id),
    })).filter(e => memberIds.has(e.id))
    const intercompany = await loadFamilyIntercompany(admin, gate.fundId, members)
    return NextResponse.json({ group: { id: group.id, name: group.name }, members, intercompany })
  } catch (e) {
    return dbError(e as Error, 'firm-family')
  }
}
