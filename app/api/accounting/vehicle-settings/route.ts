import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts). The middleware has already checked the grant.
import { assertWriteAccess, assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { dbError } from '@/lib/api-error'

// ── GPU fleet (P2) ── how often a GPU SPV distributes (Karl, Q4); P5's distribution form reads it.
const DISTRIBUTION_CADENCES = ['monthly', 'quarterly', 'annual', 'ad_hoc'] as const

// Per-vehicle operational settings that aren't part of the books.
//
// Wire instructions for capital-call notices. Kept on the VEHICLE rather than on each call — an
// SPV's bank details are a standing fact, and re-typing them into every call is how one notice
// goes out with a stale account number. The same goes for the LPA's capital call notice period,
// which every drafted notice is checked against (lib/accounting/capital-call-check.ts); changing it
// is admin-only, like the other LPA terms (lib/access/admin-only.ts).
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group
  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)

  const q = (cols: string) => admin
    .from('vehicle_accounting_settings' as any)
    .select(cols)
    .eq('fund_id', gate.fundId).eq('vehicle_id', vehicleId)
    .maybeSingle()
  let res = await q('wire_instructions, call_notice_days, call_notice_basis, distribution_cadence')
  // Before a newer column is pushed, the older settings still answer.
  if (res.error) res = await q('wire_instructions, call_notice_days, call_notice_basis')
  if (res.error) res = await q('wire_instructions')
  const data = res.data as any
  return NextResponse.json({
    wireInstructions: data?.wire_instructions ?? '',
    callNoticeDays: data?.call_notice_days ?? null,
    callNoticeBasis: data?.call_notice_basis ?? null,
    distributionCadence: data?.distribution_cadence ?? 'quarterly',
  })
}

// PATCH — { wireInstructions?, callNoticeDays?, callNoticeBasis?, distributionCadence? }
export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const group = await resolveGroupOr400(admin, gate, body?.group ?? req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group
  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)
  if (!vehicleId) return NextResponse.json({ error: `Unknown vehicle "${group}".` }, { status: 400 })

  const row: Record<string, unknown> = { fund_id: gate.fundId, vehicle_id: vehicleId, updated_at: new Date().toISOString() }
  if (body?.wireInstructions !== undefined) {
    if (typeof body.wireInstructions !== 'string') return NextResponse.json({ error: 'wireInstructions must be a string' }, { status: 400 })
    row.wire_instructions = body.wireInstructions.trim() || null
  }
  if (body?.callNoticeDays !== undefined) {
    const d = body.callNoticeDays
    if (d !== null && !(Number.isInteger(d) && d >= 0 && d <= 365)) return NextResponse.json({ error: 'callNoticeDays must be a whole number of days, 0 to 365, or null' }, { status: 400 })
    row.call_notice_days = d
  }
  if (body?.callNoticeBasis !== undefined) {
    if (body.callNoticeBasis !== null && body.callNoticeBasis !== 'calendar' && body.callNoticeBasis !== 'business') {
      return NextResponse.json({ error: "callNoticeBasis must be 'calendar' or 'business'" }, { status: 400 })
    }
    row.call_notice_basis = body.callNoticeBasis
  }
  if (body?.distributionCadence !== undefined) {
    if (!(DISTRIBUTION_CADENCES as readonly unknown[]).includes(body.distributionCadence)) {
      return NextResponse.json({ error: `distributionCadence must be one of ${DISTRIBUTION_CADENCES.join(', ')}` }, { status: 400 })
    }
    row.distribution_cadence = body.distributionCadence
  }
  if (Object.keys(row).length === 3) {
    return NextResponse.json({ error: 'Send wireInstructions, callNoticeDays, callNoticeBasis or distributionCadence' }, { status: 400 })
  }

  // Upsert: a vehicle that has never had accounting settings has no row yet.
  const { error } = await admin
    .from('vehicle_accounting_settings' as any)
    .upsert(row, { onConflict: 'fund_id,vehicle_id' })
  if (error) return dbError(error, 'accounting-vehicle-settings')
  return NextResponse.json({ ok: true })
}
