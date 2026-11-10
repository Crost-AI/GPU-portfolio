import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { loadSettlements } from '@/lib/accounting/capital-calls'
import { loadSettlementReviews, reviewCapitalSettlement } from '@/lib/accounting/settlement-reviews'

async function scope(req: NextRequest, write: boolean) {
  const client = await createClient()
  const { data: { user } } = await client.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient()
  const gate = await (write ? assertWriteAccess : assertReadAccess)(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group
  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)
  return { admin, fundId: gate.fundId, vehicleId, group, userId: user.id }
}

export async function GET(req: NextRequest) {
  const ctx = await scope(req, false)
  if (ctx instanceof NextResponse) return ctx
  const kind = req.nextUrl.searchParams.get('kind')
  if (kind !== 'call' && kind !== 'distribution') return NextResponse.json({ error: 'Invalid payment kind' }, { status: 400 })
  const [payments, reviews] = await Promise.all([
    loadSettlements(ctx.admin, ctx.fundId, ctx.group, kind === 'call' ? 'receivable' : 'payable'),
    loadSettlementReviews(ctx.admin, ctx.fundId, ctx.vehicleId, kind),
  ])
  return NextResponse.json({ payments, reviews })
}

export async function POST(req: NextRequest) {
  const ctx = await scope(req, true)
  if (ctx instanceof NextResponse) return ctx
  // Every scoping in the RPC keys off the vehicle id; a null one matches no line, so say so here
  // rather than returning the RPC's "no recorded payment" for what is a registry problem.
  if (!ctx.vehicleId) return NextResponse.json({ error: `"${ctx.group}" is not in this fund's vehicle registry` }, { status: 400 })
  const body = await req.json().catch(() => null)
  // A bounded list: one obligation is matched against a handful of wires, and the RPC loops once
  // per link under an advisory lock that serialises every other decision for this partner.
  const result = await reviewCapitalSettlement(ctx.admin, ctx.fundId, ctx.vehicleId, ctx.userId, body)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ ok: true })
}
