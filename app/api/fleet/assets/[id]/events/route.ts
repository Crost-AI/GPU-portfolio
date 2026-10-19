import { NextRequest, NextResponse } from 'next/server'
import { fetchAllRows } from '@/lib/accounting/load'
import { fleetRowRequest } from '@/lib/gpu/http'
import { GPU_EVENT_KINDS, type GpuAssetRow } from '@/lib/gpu/types'

// ── GPU fleet (P1) ── A server's manual downtime, maintenance, RMA and relocation log (decision
// Q9: no monitoring feed). `fleet` domain; the asset's own vehicle is the entity checked.

type Params = { params: Promise<{ id: string }> }

export async function GET(_req: NextRequest, props: Params) {
  const { id } = await props.params
  const r = await fleetRowRequest<GpuAssetRow>('read', 'gpu_assets', id)
  if (r instanceof NextResponse) return r
  const events = await fetchAllRows((from, to) => (r.req.admin as any).from('gpu_asset_events').select('*')
    .eq('fund_id', r.req.fundId).eq('vehicle_id', r.req.vehicleId).eq('asset_id', id).order('starts_at').range(from, to))
  return NextResponse.json({ events })
}

export async function POST(req: NextRequest, props: Params) {
  const { id } = await props.params
  const r = await fleetRowRequest<GpuAssetRow>('write', 'gpu_assets', id)
  if (r instanceof NextResponse) return r
  const b = await req.json().catch(() => ({}))
  const ts = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v))
  if (!GPU_EVENT_KINDS.includes(b?.kind)) return NextResponse.json({ error: `kind must be one of ${GPU_EVENT_KINDS.join(', ')}` }, { status: 400 })
  if (!ts(b.starts_at)) return NextResponse.json({ error: 'starts_at must be a timestamp' }, { status: 400 })
  if (b.ends_at != null && (!ts(b.ends_at) || Date.parse(b.ends_at) < Date.parse(b.starts_at))) {
    return NextResponse.json({ error: 'ends_at must be a timestamp on or after starts_at' }, { status: 400 })
  }
  if (b.gpus_affected != null && !(Number.isInteger(b.gpus_affected) && b.gpus_affected > 0 && b.gpus_affected <= r.row.gpu_count)) {
    return NextResponse.json({ error: `gpus_affected must be a whole number from 1 to ${r.row.gpu_count}` }, { status: 400 })
  }
  const { data, error } = await (r.req.admin as any).from('gpu_asset_events').insert({
    fund_id: r.req.fundId, vehicle_id: r.req.vehicleId, asset_id: id, kind: b.kind, starts_at: b.starts_at, ends_at: b.ends_at ?? null,
    gpus_affected: b.gpus_affected ?? null, cause: typeof b.cause === 'string' ? b.cause.slice(0, 500) : null, created_by: r.req.userId,
  }).select('*').single()
  if (error) return NextResponse.json({ error: 'Could not save the event' }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}
