import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { queueDealResearch } from '@/lib/deals/service'
import { outcomeResponse } from '@/lib/service-outcome'

/**
 * Queue external web research for an inbound deal on demand.
 *
 * Automatic research only runs for deals that clear the fund's interest bar
 * (thesis fit ≥ deal_research_min_fit). This endpoint is the manual override:
 * a partner who finds a low-scored deal interesting anyway can ask for research
 * explicitly. That is a deliberate human decision to spend the money, so it
 * bypasses the fit gate — but not the enabled flag.
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

  return outcomeResponse(await queueDealResearch(admin, fundId, params.id))
}
