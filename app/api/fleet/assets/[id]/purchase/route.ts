import { NextRequest, NextResponse } from 'next/server'
import { purchaseAsset } from '@/lib/gpu/assets'
import { fleetRowRequest, refusal, requireAccountingWrite } from '@/lib/gpu/http'
import type { GpuAssetRow } from '@/lib/gpu/types'

// ── GPU fleet (P1) ── Book a server's purchase: Dr 1600-<a> / Cr 1000, or Cr 2000 when invoiced.
// `fleet` write (middleware) and `accounting` write (here): it posts to the ledger.

type Params = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, props: Params) {
  const { id } = await props.params
  const r = await fleetRowRequest<GpuAssetRow>('write', 'gpu_assets', id)
  if (r instanceof NextResponse) return r
  const denied = requireAccountingWrite(r.req.access)
  if (denied) return denied
  const b = await req.json().catch(() => ({}))
  if (typeof b?.entryDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.entryDate)) {
    return NextResponse.json({ error: 'entryDate must be YYYY-MM-DD' }, { status: 400 })
  }
  const result = await purchaseAsset(r.req.admin, r.req.ctx, r.row, { entryDate: b.entryDate, invoiced: b.invoiced === true })
  return 'error' in result ? refusal(result) : NextResponse.json(result)
}
