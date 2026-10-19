import { NextRequest, NextResponse } from 'next/server'
import { assetRefsError, listAssets, parseAssetInput } from '@/lib/gpu/assets'
import { fleetRequest } from '@/lib/gpu/http'
import { parseAsOf, valueAssets } from '@/lib/gpu/valuation'

// ── GPU fleet (P1) ── A GPU SPV's register (`fleet` domain). GET ?group= lists it in a stable order,
// each row with its capitalized costs read from the ledger; POST adds a server.

const CREATABLE_STATUSES: string[] = ['planned', 'in_service', 'offline']

// ?as_of=YYYY-MM-DD (default today): each row carries its valuation as of then (lib/gpu/valuation.ts),
// with capitalized_costs as of the same date.
export async function GET(req: NextRequest) {
  const asOf = parseAsOf(req.nextUrl.searchParams.get('as_of'))
  if (!asOf) return NextResponse.json({ error: 'as_of must be a date, YYYY-MM-DD' }, { status: 400 })
  const r = await fleetRequest('read', req.nextUrl.searchParams.get('group'))
  if (r instanceof NextResponse) return r
  const rows = await listAssets(r.admin, r.fundId, r.vehicleId)
  const values = await valueAssets(r.admin, r.fundId, r.vehicleId, rows, asOf)
  return NextResponse.json({ assets: rows.map(row => ({ ...row, ...values.get(row.id) })) })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const r = await fleetRequest('write', body?.group)
  if (r instanceof NextResponse) return r
  const parsed = parseAssetInput(body, false)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  // A new asset starts planned (the default), or in_service/offline for a fleet already running when
  // it is registered. `ordered` is the purchase claim's state (purchaseAsset) and `disposed` the
  // disposal's, so neither can be created by hand.
  if (parsed.value.status !== undefined && !CREATABLE_STATUSES.includes(parsed.value.status)) {
    return NextResponse.json({ error: `A new asset's status must be one of ${CREATABLE_STATUSES.join(', ')}; it becomes ordered by booking its purchase` }, { status: 400 })
  }
  const refs = await assetRefsError(r.admin, r.ctx, parsed.value)
  if (refs) return NextResponse.json({ error: refs }, { status: 400 })
  const { data, error } = await (r.admin as any).from('gpu_assets')
    .insert({ ...parsed.value, fund_id: r.fundId, vehicle_id: r.vehicleId, created_by: r.userId }).select('*').single()
  if (error) return NextResponse.json({ error: 'Could not save the asset' }, { status: 500 })
  return NextResponse.json({ ...data, capitalized_costs: 0 }, { status: 201 })
}
