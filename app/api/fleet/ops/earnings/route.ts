import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// fleet domain (lib/access/route-domains.ts). The middleware has already checked the grant.
import { fleetRequest, needsAccountingWrite } from '@/lib/gpu/ops/http'
import { fetchAllRows } from '@/lib/accounting/load'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { ignoreEarnings, postEarnings } from '@/lib/gpu/ops/post'
import { EARNING_STATUSES, type EarningRow } from '@/lib/gpu/ops/types'

export const runtime = 'nodejs'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

// GET ?group=&from=&to=&status= — the vehicle's entered periods, newest period end first, then by
// server name. `from`/`to` bound the period end.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const params = req.nextUrl.searchParams
  const ctx = await fleetRequest(admin, user.id, 'read', params.get('group'))
  if (ctx instanceof NextResponse) return ctx
  const from = params.get('from')
  const to = params.get('to')
  const status = params.get('status')
  if ((from && !ISO_DATE.test(from)) || (to && !ISO_DATE.test(to))) return NextResponse.json({ error: 'from and to must be YYYY-MM-DD' }, { status: 400 })
  if (status && !(EARNING_STATUSES as readonly string[]).includes(status)) return NextResponse.json({ error: `status must be one of ${EARNING_STATUSES.join(', ')}` }, { status: 400 })

  const fundId = ctx.gate.fundId
  const vehicleId = await vehicleIdByName(admin, fundId, ctx.group)
  const [rows, assets] = await Promise.all([
    fetchAllRows<EarningRow>((f, t) => {
      let q = (admin as any).from('gpu_earnings').select('*').eq('fund_id', fundId).eq('vehicle_id', vehicleId)
      if (from) q = q.gte('period_end', from)
      if (to) q = q.lte('period_end', to)
      if (status) q = q.eq('status', status)
      return q.order('period_end', { ascending: false }).range(f, t)
    }),
    fetchAllRows<{ id: string; name: string }>((f, t) => (admin as any).from('gpu_assets').select('id, name')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).range(f, t)),
  ])
  const nameOf = new Map(assets.map(a => [a.id, a.name]))
  const out = rows.map(r => ({
    id: r.id, runId: r.run_id ?? null, assetId: r.asset_id ?? null, assetName: r.asset_id ? nameOf.get(r.asset_id) ?? null : null, assetRef: r.asset_ref,
    periodStart: r.period_start, periodEnd: r.period_end,
    gpuHoursRented: r.gpu_hours_rented == null ? null : Number(r.gpu_hours_rented),
    utilizationPct: r.utilization_pct == null ? null : Number(r.utilization_pct),
    gross: Number(r.gross), fee: Number(r.marketplace_fee), net: Number(r.net), downtimeHours: Number(r.downtime_hours),
    note: r.note, currency: r.currency, status: r.status, supersedesId: r.supersedes_id ?? null, entryId: r.journal_entry_id ?? null,
  }))
  const by = (r: typeof out[number]) => (r.assetName ?? r.assetRef).toLowerCase()
  out.sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : a.periodEnd > b.periodEnd ? -1 : by(a) < by(b) ? -1 : by(a) > by(b) ? 1 : 0))
  return NextResponse.json({ rows: out })
}

// POST { group, action: 'post' | 'ignore', ids, confirmReversal? }. Posting books revenue, so it
// also needs accounting write. A row that replaces a posted period answers `{ needsReversal }`
// until it is re-sent with confirmReversal: true.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const ctx = await fleetRequest(admin, user.id, 'write', body?.group)
  if (ctx instanceof NextResponse) return ctx
  const ids: unknown = body?.ids
  if (!Array.isArray(ids) || !ids.every(i => typeof i === 'string')) return NextResponse.json({ error: 'ids must be a list of row ids' }, { status: 400 })

  if (body?.action === 'ignore') {
    const result = await ignoreEarnings(admin, ctx.gate.fundId, ctx.group, ids)
    if ('error' in result) return NextResponse.json(result, { status: 400 })
    return NextResponse.json(result)
  }
  if (body?.action !== 'post') return NextResponse.json({ error: "action must be 'post' or 'ignore'" }, { status: 400 })
  const denied = needsAccountingWrite(ctx.access, 'Posting revenue')
  if (denied) return denied
  const result = await postEarnings(admin, ctx.gate.fundId, ctx.group, user.id, ids, { confirmReversal: body?.confirmReversal === true })
  if ('error' in result) return NextResponse.json(result, { status: 400 })
  return NextResponse.json(result)
}
