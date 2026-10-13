import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { outcomeResponse } from '@/lib/service-outcome'
import { shareLetter } from '@/lib/lp-letters/service'

/**
 * Admin-only LP letter sharing (Phase 3 of LP reporting).
 *
 *   GET    → lp_investor_ids this letter is shared with.
 *   POST   { lp_investor_ids: string[] } → set the share list (upsert + prune).
 *   DELETE ?lp_investor_id=... → unshare a single investor.
 */

async function adminCtx(letterId: string) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return { error: writeCheck }
  if (writeCheck.role !== 'admin') return { error: NextResponse.json({ error: 'Admin access required' }, { status: 403 }) }

  const { data: letter } = await (admin as any)
    .from('lp_letters')
    .select('id, fund_id')
    .eq('id', letterId)
    .eq('fund_id', writeCheck.fundId)
    .maybeSingle()
  if (!letter) return { error: NextResponse.json({ error: 'Letter not found' }, { status: 404 }) }

  return { admin, user, fundId: writeCheck.fundId as string, letterId }
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await adminCtx(params.id)
  if ('error' in ctx) return ctx.error
  const { admin, fundId, letterId } = ctx

  const { data, error } = await (admin as any)
    .from('lp_letter_shares')
    .select('lp_investor_id')
    .eq('letter_id', letterId)
    .eq('fund_id', fundId)
  if (error) return dbError(error, 'lp-letters-share')
  return NextResponse.json({ lp_investor_ids: (data ?? []).map((r: any) => r.lp_investor_id) })
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await adminCtx(params.id)
  if ('error' in ctx) return ctx.error
  const { admin, user, fundId, letterId } = ctx

  const body = await req.json().catch(() => ({}))
  const requested: string[] = Array.isArray(body.lp_investor_ids) ? body.lp_investor_ids : []
  const out = await shareLetter(admin, { fundId, userId: user.id }, letterId, requested)
  return outcomeResponse(out, v => ({ ok: true, ...v }))
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await adminCtx(params.id)
  if ('error' in ctx) return ctx.error
  const { admin, fundId, letterId } = ctx

  const lpInvestorId = new URL(req.url).searchParams.get('lp_investor_id') ?? ''
  if (!lpInvestorId) return NextResponse.json({ error: 'lp_investor_id is required' }, { status: 400 })

  const { error } = await (admin as any)
    .from('lp_letter_shares')
    .delete()
    .eq('letter_id', letterId)
    .eq('fund_id', fundId)
    .eq('lp_investor_id', lpInvestorId)
  if (error) return dbError(error, 'lp-letters-share')
  return NextResponse.json({ ok: true })
}
