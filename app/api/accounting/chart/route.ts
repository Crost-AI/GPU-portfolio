import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts). The middleware has already checked the caller's
// grant for this route + method; these resolve identity and keep the demo out of writes.
import { assertWriteAccess, assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { dbError } from '@/lib/api-error'
import { chartForVehicleKind } from '@/lib/accounting/chart'
import { ensureVehicleAccounts } from '@/lib/accounting/provision-accounts'
import { addChartAccount } from '@/lib/accounting/chart-add'


// GET — list the vehicle's chart of accounts.
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

  // An entity created before charts were seeded on creation gets its chart on first look, so no
  // page has to offer to set one up. Idempotent (ensureVehicleAccounts upserts, by kind).
  if (vehicleId) {
    const { count } = await admin.from('chart_of_accounts' as any).select('id', { count: 'exact', head: true })
      .eq('fund_id', gate.fundId).eq('vehicle_id', vehicleId)
    if (!count) {
      // A seed failure must not fail the read: fall through to the plain select.
      try { await ensureVehicleAccounts(admin, gate.fundId, group) } catch (e) { console.error('Seeding the chart on first look failed:', e) }
    }
  }

  const { data, error } = await admin
    .from('chart_of_accounts' as any)
    .select('*')
    .eq('fund_id', gate.fundId)
    .eq('vehicle_id', vehicleId)
    .order('code', { ascending: true })
  if (error) return dbError(error, 'accounting-chart')
  return NextResponse.json(data ?? [])
}

// POST — seed the default chart for the vehicle. Additive: seeds everything on first run and
// backfills any standard account added since, so it is also the way an existing vehicle picks up
// a new one (e.g. 2300 Distributions payable). Never touches existing or custom accounts.
export async function POST(req: NextRequest) {
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

  // Add ONE account (lib/accounting/chart-add.ts, shared with the agent's add_account tool).
  if (body?.action === 'add') {
    const result = await addChartAccount(admin, gate.fundId, group, body)
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json(result.account)
  }

  // The chart follows the vehicle's kind: a GP/associate entity keeps its own books (Investment in
  // Fund, members' capital, carry), a management company keeps an operating company's (payroll,
  // occupancy, deferred fee revenue, intercompany), and everything else gets the fund chart.
  const { data: veh } = await admin.from('fund_vehicles' as any).select('kind').eq('fund_id', gate.fundId).eq('id', vehicleId).maybeSingle()
  const chart = chartForVehicleKind((veh as any)?.kind)

  // Additive/idempotent: seed the full chart on first run, and on later runs
  // backfill any accounts the vehicle is missing (e.g. a newly-added standard
  // account). Never touches existing rows or custom accounts.
  const { data: existing } = await admin
    .from('chart_of_accounts' as any)
    .select('code')
    .eq('fund_id', gate.fundId)
    .eq('vehicle_id', vehicleId)
  const have = new Set(((existing as any[]) ?? []).map(r => r.code as string))
  const missing = chart.filter(a => !have.has(a.code))
  if (missing.length === 0) return NextResponse.json({ seeded: 0, message: 'Chart already up to date' })

  const rows = missing.map(a => ({ fund_id: gate.fundId, portfolio_group: group, vehicle_id: vehicleId, code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null }))
  const { data, error } = await admin.from('chart_of_accounts' as any).upsert(rows, { onConflict: 'fund_id,portfolio_group,code', ignoreDuplicates: true }).select('*')
  if (error) return dbError(error, 'accounting-chart-seed')
  return NextResponse.json({ seeded: (data as any[])?.length ?? 0, accounts: data ?? [] })
}

// PATCH — rename an account, or hide/show it. Body: { id, name?, isActive? }
//
// The CODE is never editable. Code is how the rest of the system finds an account —
// `codes.get('1000')`, RECEIVABLE_CODE '1300', BRIDGE_CODE '3200', DISTRIBUTION_PAYABLE_CODE
// '2300' — so renumbering one would break the close, capital calls and bank booking with an
// error far from the cause. Names are free: nothing reads them.
//
// Hiding is a PICKER concern only. A hidden account keeps every posting it has and stays in the
// trial balance, balance sheet and statements — an account with a balance that vanished from the
// financials would be a way to misstate them. It simply stops being offered for NEW postings.
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

  const id = String(body?.id ?? '')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const { data: acct } = await admin
    .from('chart_of_accounts' as any)
    .select('id, lp_entity_id')
    .eq('id', id).eq('fund_id', gate.fundId).eq('vehicle_id', vehicleId)
    .maybeSingle()
  if (!acct) return NextResponse.json({ error: 'Account not found on this vehicle' }, { status: 404 })
  // Per-partner capital accounts are DERIVED — created and named by ensureCapitalAccounts from
  // the partner. Renaming one would drift from the partner's name; hiding one would remove that
  // partner from the entry modal, which is how a posting is attributed to them.
  if ((acct as any).lp_entity_id) {
    return NextResponse.json({ error: "A partner's capital account follows the partner — edit the partner instead." }, { status: 400 })
  }

  const patch: Record<string, unknown> = {}
  if (typeof body?.name === 'string') {
    const name = body.name.trim()
    if (!name) return NextResponse.json({ error: 'A name is required' }, { status: 400 })
    patch.name = name
  }
  if (typeof body?.isActive === 'boolean') patch.is_active = body.isActive
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'Nothing to change' }, { status: 400 })

  const { data, error } = await admin.from('chart_of_accounts' as any)
    .update(patch).eq('id', id).eq('fund_id', gate.fundId).select('*').single()
  if (error) return dbError(error, 'accounting-chart-update')
  return NextResponse.json(data)
}
