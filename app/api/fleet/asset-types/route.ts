import { NextRequest, NextResponse } from 'next/server'
import { fetchAllRows } from '@/lib/accounting/load'
import { fleetFund } from '@/lib/gpu/http'

// ── GPU fleet (P1) ── The fund's GPU server types (`fleet` domain, lib/access/route-domains.ts).
// Fund-level reference data with no vehicle column, so there is no entity to check: the middleware's
// `fleet` gate is the whole gate.

export async function GET() {
  const f = await fleetFund('read')
  if (f instanceof NextResponse) return f
  const rows = await fetchAllRows((from, to) => (f.admin as any).from('gpu_asset_types').select('*')
    .eq('fund_id', f.fundId).order('code').range(from, to))
  return NextResponse.json({ assetTypes: rows })
}

export async function POST(req: NextRequest) {
  const f = await fleetFund('write')
  if (f instanceof NextResponse) return f
  const b = await req.json().catch(() => ({}))
  if (typeof b?.code !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(b.code)) {
    return NextResponse.json({ error: 'code must be lowercase letters, digits and hyphens (e.g. h200-nvl)' }, { status: 400 })
  }
  if (typeof b.label !== 'string' || !b.label.trim()) return NextResponse.json({ error: 'label is required' }, { status: 400 })
  const gpus = b.gpus_per_server ?? 8
  if (!Number.isInteger(gpus) || gpus <= 0) return NextResponse.json({ error: 'gpus_per_server must be a positive whole number' }, { status: 400 })
  if (b.anchor_rate != null && !(typeof b.anchor_rate === 'number' && b.anchor_rate >= 0)) {
    return NextResponse.json({ error: 'anchor_rate must be a number, zero or more' }, { status: 400 })
  }
  const { data, error } = await (f.admin as any).from('gpu_asset_types').insert({
    fund_id: f.fundId, code: b.code, label: b.label.trim(), gpus_per_server: gpus, anchor_rate: b.anchor_rate ?? null,
    gpu_model: typeof b.gpu_model === 'string' ? b.gpu_model : null, notes: typeof b.notes === 'string' ? b.notes : null,
  }).select('*').single()
  if (error) {
    if ((error as { code?: string }).code === '23505') return NextResponse.json({ error: `A GPU type with code ${b.code} already exists` }, { status: 409 })
    return NextResponse.json({ error: 'Could not save the GPU type' }, { status: 500 })
  }
  return NextResponse.json(data, { status: 201 })
}
