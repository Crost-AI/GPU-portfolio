import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { updateAttentionItem } from '@/lib/diligence/service'
import { outcomeResponse } from '@/lib/service-outcome'

export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ id: string; itemId: string }> }
) {
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

  const body = await req.json().catch(() => ({}))
  const result = await updateAttentionItem(admin, { fundId, userId: user.id }, params.id, params.itemId, {
    status: body.status,
    resolutionNote: body.resolution_note,
  })
  return outcomeResponse(result, () => ({ ok: true }))
}
