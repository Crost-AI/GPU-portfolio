// A vehicle's management-fee terms — for a GPU SPV, a share of gross rental revenue that the
// close accrues month by month (lib/gpu/fee.ts).
//
//   GET  ?group=X   the terms, or null when the vehicle has none
//   PUT  { group, basis, annualRate, revenueSubtypes?, frequency?, payeeVehicleId?, effectiveFrom, effectiveTo? }
//
// accounting domain (lib/access/route-domains.ts). vehicle_fee_terms is service-role only, so this
// route is its only door.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess, assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400, resolveGroupWithAccess } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { DEFAULT_FEE_REVENUE_SUBTYPES, FEE_BASES, FEE_FREQUENCIES, loadFeeTerms } from '@/lib/gpu/fee'
import { MANCO_KIND } from '@/lib/vehicle-kinds'
import { hasAccess } from '@/lib/access/effective'
import { canSeeVehicle } from '@/lib/access/scope'
import { dbError } from '@/lib/api-error'

const DATE = /^\d{4}-\d{2}-\d{2}$/

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group
  try {
    return NextResponse.json({ group, terms: await loadFeeTerms(admin, gate.fundId, group) })
  } catch (e) {
    return dbError({ message: e instanceof Error ? e.message : String(e) }, 'fee-terms-get')
  }
}

export async function PUT(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  // The access context the entity check loads is the one the payee check reuses: one round trip.
  const resolved = await resolveGroupWithAccess(admin, gate, body?.group ?? req.nextUrl.searchParams.get('group'))
  if (resolved instanceof NextResponse) return resolved
  const { group, access } = resolved
  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)
  if (!vehicleId) return NextResponse.json({ error: `Unknown vehicle "${group}".` }, { status: 400 })

  const basis = body?.basis
  if (!(FEE_BASES as readonly string[]).includes(basis)) {
    return NextResponse.json({ error: `basis must be one of ${FEE_BASES.join(', ')}.` }, { status: 400 })
  }
  const annualRate = Number(body?.annualRate)
  if (!Number.isFinite(annualRate) || annualRate < 0 || annualRate >= 1) {
    return NextResponse.json({ error: 'The fee rate must be a fraction between 0 and 1 (0.05 = 5%).' }, { status: 400 })
  }
  const revenueSubtypes = body?.revenueSubtypes == null ? DEFAULT_FEE_REVENUE_SUBTYPES : body.revenueSubtypes
  if (!Array.isArray(revenueSubtypes) || revenueSubtypes.length === 0 || !revenueSubtypes.every((t: unknown) => typeof t === 'string' && t.length > 0)) {
    return NextResponse.json({ error: 'revenueSubtypes must be a non-empty list of account subtypes.' }, { status: 400 })
  }
  const frequency = body?.frequency ?? 'monthly'
  if (!(FEE_FREQUENCIES as readonly string[]).includes(frequency)) {
    return NextResponse.json({ error: 'frequency must be monthly or quarterly.' }, { status: 400 })
  }
  const effectiveFrom = body?.effectiveFrom
  const effectiveTo = body?.effectiveTo ?? null
  if (typeof effectiveFrom !== 'string' || !DATE.test(effectiveFrom)) {
    return NextResponse.json({ error: 'effectiveFrom (YYYY-MM-DD) is required.' }, { status: 400 })
  }
  if (effectiveTo !== null && (typeof effectiveTo !== 'string' || !DATE.test(effectiveTo) || effectiveTo < effectiveFrom)) {
    return NextResponse.json({ error: 'effectiveTo must be a date on or after effectiveFrom.' }, { status: 400 })
  }

  // The payee is the management company the fee is booked to, intercompany: one of this fund's.
  // Naming one makes the close post on the management company's books, so this payload straddles
  // domains: the route's gate is `accounting`, and the payee needs management_company write and
  // sight of that entity as well (CLAUDE.md, "the registry maps ONE domain per route").
  const payeeVehicleId = body?.payeeVehicleId || null
  if (payeeVehicleId) {
    if (payeeVehicleId === vehicleId) return NextResponse.json({ error: 'A vehicle cannot pay its fee to itself.' }, { status: 400 })
    if (!hasAccess(access, 'management_company', 'write') || !canSeeVehicle(access, payeeVehicleId)) {
      return NextResponse.json({ error: 'Booking the fee to a management company needs write access to that management company.' }, { status: 403 })
    }
    const { data: payee, error: payeeErr } = await admin.from('fund_vehicles' as any)
      .select('id, kind').eq('fund_id', gate.fundId).eq('id', payeeVehicleId).maybeSingle()
    if (payeeErr) return dbError(payeeErr, 'fee-terms-payee')
    if (!payee || (payee as any).kind !== MANCO_KIND) {
      return NextResponse.json({ error: 'The fee payee must be a management company in this fund.' }, { status: 400 })
    }
  }

  const { error } = await admin.from('vehicle_fee_terms' as any).upsert({
    fund_id: gate.fundId,
    vehicle_id: vehicleId,
    basis,
    annual_rate: annualRate,
    revenue_subtypes: revenueSubtypes,
    frequency,
    payee_vehicle_id: payeeVehicleId,
    effective_from: effectiveFrom,
    effective_to: effectiveTo,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'vehicle_id' })
  if (error) return dbError(error, 'fee-terms-put')
  return NextResponse.json({ ok: true })
}
