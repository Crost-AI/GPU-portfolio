import { NextRequest, NextResponse } from 'next/server'
import { disposeAsset } from '@/lib/gpu/disposal'
import { fleetRowRequest, refusal, requireAccountingWrite } from '@/lib/gpu/http'
import type { GpuAssetRow } from '@/lib/gpu/types'

// ── GPU fleet (P1) ── Dispose of a server: clear 1600-<a> / 1650-<a> from the ledger and book the
// difference to 4500. `fleet` write and `accounting` write.

type Params = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, props: Params) {
  const { id } = await props.params
  const r = await fleetRowRequest<GpuAssetRow>('write', 'gpu_assets', id)
  if (r instanceof NextResponse) return r
  const denied = requireAccountingWrite(r.req.access)
  if (denied) return denied
  const b = await req.json().catch(() => ({}))
  if (typeof b?.disposedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.disposedOn)) {
    return NextResponse.json({ error: 'disposedOn must be YYYY-MM-DD' }, { status: 400 })
  }
  if (typeof b.proceeds !== 'number') return NextResponse.json({ error: 'proceeds must be a number' }, { status: 400 })
  const result = await disposeAsset(r.req.admin, r.req.ctx, r.row, { disposedOn: b.disposedOn, proceeds: b.proceeds })
  return 'error' in result ? refusal(result) : NextResponse.json(result)
}
