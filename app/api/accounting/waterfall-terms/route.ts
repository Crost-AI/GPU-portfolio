// A vehicle's carry terms — what the close accrues carried interest on.
//
//   GET  ?group=X   the vehicle's terms + the partners who could receive the carry
//   PUT  ?group=X   set them
//
// Absent terms mean NO CARRY, and that is the only safe default: accruing carry nobody agreed
// to is worse than accruing none at all.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// gp_economics domain (see lib/access/route-domains.ts). The middleware has already checked the
// caller's grant for this route + method; these resolve identity and keep the demo out of writes.
import { assertWriteAccess, assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { loadCarryTerms } from '@/lib/accounting/carry'
import { loadEntityNames } from '@/lib/accounting/load'
import { dbError } from '@/lib/api-error'
import { validateCashTerms } from '@/lib/gpu/waterfall'

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  const [terms, names] = await Promise.all([
    loadCarryTerms(admin, gate.fundId, group),
    loadEntityNames(admin, gate.fundId, group),
  ])

  // Whoever could receive the carry. Normally the GP entity, but we don't force that — some
  // structures accrue it to a named associate vehicle's entity instead.
  const { data: entities } = await admin
    .from('lp_entities' as any)
    .select('id, entity_name, partner_class')
    .eq('fund_id', gate.fundId)
    .order('entity_name')

  return NextResponse.json({
    group,
    terms,
    partners: Array.from(names.entries()).map(([id, name]) => ({ lpEntityId: id, name })),
    candidates: ((entities as any[]) ?? []).map(e => ({
      lpEntityId: e.id,
      name: e.entity_name,
      partnerClass: e.partner_class ?? 'lp',
    })),
  })
}

export async function PUT(req: NextRequest) {
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

  const kind = body?.kind
  if (!['none', 'straight', 'american', 'european', 'distributable_cash'].includes(kind)) {
    return NextResponse.json({ error: 'kind must be none, straight, american, european, or distributable_cash.' }, { status: 400 })
  }

  const num = (v: any, fallback = 0) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
  }
  const carryRate = num(body?.carryRate)
  const prefRate = num(body?.prefRate)
  const catchupRate = num(body?.catchupRate, 1)

  if (carryRate < 0 || carryRate >= 1) {
    return NextResponse.json({ error: 'Carry rate must be a fraction between 0 and 1 (0.2 = 20%).' }, { status: 400 })
  }
  if (prefRate < 0 || prefRate >= 1) {
    return NextResponse.json({ error: 'Preferred return must be a fraction between 0 and 1 (0.08 = 8%).' }, { status: 400 })
  }
  if (catchupRate < 0 || catchupRate > 1) {
    return NextResponse.json({ error: 'Catch-up rate must be between 0 and 1.' }, { status: 400 })
  }

  // Carry has to accrue TO somebody. A vehicle may have ONE recipient (legacy gpEntityId) or a
  // split across several (carryRecipients: [{lpEntityId, pct}] summing to 100). Without any the
  // close would compute an accrual it cannot post — refuse here rather than fail mid-close.
  const gpEntityId = body?.gpEntityId || null
  const recipients: { lpEntityId: string; pct: number }[] = Array.isArray(body?.carryRecipients)
    ? body.carryRecipients
        .filter((r: any) => r && typeof r.lpEntityId === 'string')
        .map((r: any) => ({ lpEntityId: r.lpEntityId, pct: Number(r.pct) }))
        .filter((r: { pct: number }) => Number.isFinite(r.pct) && r.pct > 0)
    : []
  const carryOn = kind !== 'none' && carryRate > 0

  if (carryOn && recipients.length === 0 && !gpEntityId) {
    return NextResponse.json({ error: 'Choose who receives the carry.' }, { status: 400 })
  }
  if (recipients.length > 0) {
    const sum = recipients.reduce((s, r) => s + r.pct, 0)
    if (Math.abs(sum - 100) > 0.01) {
      return NextResponse.json({ error: `Carry recipient percentages must total 100 (they total ${sum}).` }, { status: 400 })
    }
  }
  // Every named recipient (and the legacy single GP) must be a partner in this fund.
  const idsToCheck = [...recipients.map(r => r.lpEntityId), ...(gpEntityId ? [gpEntityId] : [])]
  if (idsToCheck.length > 0) {
    const { data: ents } = await admin.from('lp_entities' as any).select('id').eq('fund_id', gate.fundId).in('id', idsToCheck)
    const known = new Set(((ents as any[]) ?? []).map(e => e.id))
    const foreign = idsToCheck.filter(id => !known.has(id))
    if (foreign.length > 0) return NextResponse.json({ error: 'A carry recipient is not in this fund.' }, { status: 400 })
  }

  // ── GPU fleet (P2) ── A GPU SPV's waterfall (plan §3.2): pref on unreturned capital, simple, no
  // catch-up. Stored terms are dated, so the scenario engine's 'periodic' day count is refused.
  let cashColumns: Record<string, unknown> = {}
  if (kind === 'distributable_cash') {
    const prefBasis = body?.prefBasis ?? 'unreturned'
    const prefDayCount = body?.prefDayCount ?? '30_360'
    if (prefDayCount === 'periodic') {
      return NextResponse.json({ error: 'The periodic day count is for scenarios; choose 30_360 (30E/360) or act_365.' }, { status: 400 })
    }
    const rocLpShare = body?.rocLpShare == null ? 1 : Number(body.rocLpShare)
    const invalid = validateCashTerms({
      prefRate, dayCount: String(prefDayCount), rocLpShare, carryRate,
      recipients: recipients.length > 0 ? recipients : gpEntityId ? [{ lpEntityId: gpEntityId, pct: 100 }] : [],
      catchupRate: body?.catchupRate == null ? undefined : Number(body.catchupRate),
      prefCompounds: body?.prefCompounds === true,
      prefBasis: String(prefBasis),
    })
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 })
    cashColumns = { pref_basis: 'unreturned', pref_day_count: prefDayCount, roc_lp_share: rocLpShare, catchup_rate: 1, pref_compounds: false }
  }

  // Keep gp_entity_id meaningful as the single-recipient fallback: the sole recipient when there
  // is exactly one, otherwise the explicit legacy value (or null).
  const singleGp = recipients.length === 1 ? recipients[0].lpEntityId : recipients.length === 0 ? gpEntityId : null

  const { error } = await admin
    .from('vehicle_waterfall_terms' as any)
    .upsert(
      {
        fund_id: gate.fundId,
        vehicle_id: vehicleId,
        kind,
        carry_rate: carryRate,
        pref_rate: prefRate,
        catchup_rate: catchupRate,
        pref_compounds: body?.prefCompounds !== false,
        gp_entity_id: singleGp,
        carry_recipients: recipients.length > 0 ? recipients : null,
        ...cashColumns,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'fund_id,vehicle_id' }
    )
  if (error) return dbError(error, 'waterfall-terms-put')

  return NextResponse.json({ ok: true })
}
