import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { enqueueDraftStage } from '@/lib/memo-agent/enqueue'
import { outcomeResponse } from '@/lib/service-outcome'

/**
 * Enqueue a standalone scoring job for the deal's latest memo draft. Lets the
 * partner (re)score without re-running the whole draft pipeline — e.g. after
 * the inline score failed, or after editing the rubric.
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

  const { data: deal } = await admin
    .from('diligence_deals')
    .select('id')
    .eq('id', params.id)
    .eq('fund_id', fundId)
    .maybeSingle()
  if (!deal) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return outcomeResponse(await enqueueDraftStage(admin, { fundId, userId: user.id }, params.id, 'score'))
}
