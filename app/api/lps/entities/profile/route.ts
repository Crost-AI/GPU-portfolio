import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// lp_capital domain (lib/access/route-domains.ts), like the entity and investor tables it writes.
import { assertWriteAccess } from '@/lib/api-helpers'
import { loadLpScope } from '@/lib/access/lp-scope'
import { outcomeResponse } from '@/lib/service-outcome'
import { updateEntityProfile } from '@/lib/lps/records'

/**
 * The investor record beyond a name.
 *
 *   PATCH { lp_entity_id, entity?: {...}, investor?: {...} }
 *     entity:   entity_type, formation_jurisdiction, address_line1, address_line2, city, region,
 *               postal_code, country, notice_email, signatories [{ name, title?, email? }],
 *               profile_notes — the facts a subscription document is filled from.
 *     investor: contact_name, contact_email, contact_phone — the relationship contact, and where
 *               an onboarding request goes when the investor has no portal account.
 *
 * Only the keys sent are changed. The entity must be this fund's; the investor written is the
 * entity's own, never one named in the body.
 */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const body = await req.json().catch(() => ({}))
  const entityId = typeof body.lp_entity_id === 'string' ? body.lp_entity_id : ''
  // Only an LP with a position in one of the caller's entities.
  const lp = await loadLpScope(admin, gate)
  return outcomeResponse(
    await updateEntityProfile(admin, { fundId: gate.fundId, userId: user.id, visibleEntityIds: lp.entityIds }, entityId, { entity: body.entity, investor: body.investor }),
    v => ({ ok: true, ...v }),
  )
}
