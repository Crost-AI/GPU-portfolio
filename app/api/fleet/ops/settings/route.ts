import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// fleet domain (lib/access/route-domains.ts). The middleware has already checked the grant.
import { fleetRequest, needsAccountingWrite } from '@/lib/gpu/ops/http'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'

export const runtime = 'nodejs'

// The operations settings of a GPU SPV: whether the bank auto-match books a payout match itself
// (issue #92). Off by default — the run proposes and the accountant confirms.

// GET ?group= — { autoPostPayoutMatches }
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ctx = await fleetRequest(admin, user.id, 'read', req.nextUrl.searchParams.get('group'))
  if (ctx instanceof NextResponse) return ctx
  const vehicleId = await vehicleIdByName(admin, ctx.gate.fundId, ctx.group)
  const { data, error } = await (admin as any).from('gpu_fleet_settings').select('auto_post_payout_matches')
    .eq('fund_id', ctx.gate.fundId).eq('vehicle_id', vehicleId).maybeSingle()
  if (error) return NextResponse.json({ error: 'The settings could not be read' }, { status: 500 })
  return NextResponse.json({ autoPostPayoutMatches: data?.auto_post_payout_matches === true })
}

// PATCH { group, autoPostPayoutMatches: boolean }. Letting the run post to the books needs
// accounting write as well as fleet write.
export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const ctx = await fleetRequest(admin, user.id, 'write', body?.group)
  if (ctx instanceof NextResponse) return ctx
  if (typeof body?.autoPostPayoutMatches !== 'boolean') return NextResponse.json({ error: 'autoPostPayoutMatches must be true or false' }, { status: 400 })
  const denied = needsAccountingWrite(ctx.access, 'Changing how payouts are booked')
  if (denied) return denied

  const vehicleId = await vehicleIdByName(admin, ctx.gate.fundId, ctx.group)
  const { error } = await (admin as any).from('gpu_fleet_settings').upsert(
    { fund_id: ctx.gate.fundId, vehicle_id: vehicleId, auto_post_payout_matches: body.autoPostPayoutMatches, updated_at: new Date().toISOString() },
    { onConflict: 'vehicle_id' },
  )
  if (error) return NextResponse.json({ error: 'The settings could not be saved' }, { status: 500 })
  return NextResponse.json({ autoPostPayoutMatches: body.autoPostPayoutMatches })
}
