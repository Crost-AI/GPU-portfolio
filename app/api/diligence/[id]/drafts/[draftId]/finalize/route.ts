import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { finalizeMemo } from '@/lib/diligence/service'
import { outcomeResponse } from '@/lib/service-outcome'

/**
 * Finalize a memo draft. Admin-only. Sets is_draft=false, finalized_at, and
 * finalized_by. The DB constraint (`finalize_consistency`) enforces all three
 * change together. Once finalized, PATCH on the draft returns 409.
 */
export async function POST(
  _req: NextRequest,
  props: { params: Promise<{ id: string; draftId: string }> }
) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })
  if ((membership as any).role !== 'admin') return NextResponse.json({ error: 'Admin required' }, { status: 403 })

  const fundId = (membership as any).fund_id as string

  // The recommendation is partner_only: lib/diligence/service.ts refuses a draft whose
  // recommendation is still the placeholder.
  const result = await finalizeMemo(admin, { fundId, userId: user.id }, params.id, params.draftId)
  return outcomeResponse(result, () => ({ ok: true }))
}
