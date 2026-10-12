import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { promoteInboundDeal } from '@/lib/deals/service'
import { outcomeResponse } from '@/lib/service-outcome'

/**
 * Promote an inbound deal into the Diligence flow. Creates a diligence_deals
 * row pre-filled from the inbound deal, links the two via
 * inbound_deals.promoted_diligence_id, and flips the inbound deal status to
 * `diligence`. Returns the new diligence_deal id so the UI can redirect.
 *
 * If the inbound deal already has a promoted_diligence_id, returns 409 with
 * the existing id rather than double-creating. The work is lib/deals/service.ts promoteInboundDeal,
 * which `deals_promote_to_diligence` calls from chat.
 */
export async function POST(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })
  const fundId = (membership as any).fund_id as string

  const result = await promoteInboundDeal(admin, { fundId, userId: user.id }, params.id)
  return outcomeResponse(result, v => ({ ok: true, diligence_id: v.diligenceId }))
}
