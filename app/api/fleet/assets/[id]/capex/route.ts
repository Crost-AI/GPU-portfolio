import { NextRequest, NextResponse } from 'next/server'
import { capitalizeCost } from '@/lib/gpu/assets'
import { fleetRowRequest, refusal, requireAccountingWrite } from '@/lib/gpu/http'
import type { GpuAssetRow } from '@/lib/gpu/types'

// ── GPU fleet (P1) ── Capitalize a real installation, shipping or spares cost into a server
// (decision R8/Q6). `key` is the caller's identity for the cost (an invoice or bank-row id, or a
// request key): a retry with the same key books nothing new. `fleet` write and `accounting` write.

type Params = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, props: Params) {
  const { id } = await props.params
  const r = await fleetRowRequest<GpuAssetRow>('write', 'gpu_assets', id)
  if (r instanceof NextResponse) return r
  const denied = requireAccountingWrite(r.req.access)
  if (denied) return denied
  const b = await req.json().catch(() => ({}))
  if (typeof b?.amount !== 'number') return NextResponse.json({ error: 'amount must be a number' }, { status: 400 })
  const result = await capitalizeCost(r.req.admin, r.req.ctx, r.row, {
    key: typeof b.key === 'string' ? b.key : '', entryDate: typeof b.entryDate === 'string' ? b.entryDate : '',
    amount: b.amount, invoiced: b.invoiced === true, memo: typeof b.memo === 'string' ? b.memo.slice(0, 200) : undefined,
  })
  return 'error' in result ? refusal(result) : NextResponse.json(result)
}
