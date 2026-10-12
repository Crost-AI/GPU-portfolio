import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { loadAccessContext } from '@/lib/access/effective'
import { loadVehicleGroups } from '@/lib/vehicle-groups-server'
import { dbError } from '@/lib/api-error'

// GET — the entity groups every entity list sections itself by: { groups, assignments }.
//
// Any member (see route-domains.ts): the lists that read it span four domains, and the payload is
// labels, not figures — each list's own route decides which entities and numbers it shows. The
// assignments are filtered to the entities the caller may see, and a scoped caller gets only the
// groups holding one of them. Managed by admins under api/settings/vehicle-groups.
export async function GET() {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
  try {
    return NextResponse.json(await loadVehicleGroups(admin, gate.fundId, access))
  } catch (e) {
    return dbError(e as any, 'vehicle-groups')
  }
}
