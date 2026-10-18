import { NextRequest, NextResponse } from 'next/server'
import { accountIdsByCode } from '@/lib/gpu/assets'
import { fleetRowRequest, refusal, requireAccountingWrite } from '@/lib/gpu/http'
import { CONTRACT_TERMS, DATACENTER_CODES, ensureDatacenterSchedule, parseContractInput } from '@/lib/gpu/opex'
import type { DatacenterContractRow } from '@/lib/gpu/types'

// ── GPU fleet (P1) ── One datacenter contract (`fleet` domain; its own vehicle is the entity checked).

type Params = { params: Promise<{ id: string }> }

export async function GET(_req: NextRequest, props: Params) {
  const { id } = await props.params
  const r = await fleetRowRequest<DatacenterContractRow>('read', 'datacenter_contracts', id)
  if (r instanceof NextResponse) return r
  return NextResponse.json(r.row)
}

// PATCH — edit the contract. Its fee terms are fixed once a schedule accrues them (a change would
// leave posted months on the old terms); end it and create a new contract instead.
export async function PATCH(req: NextRequest, props: Params) {
  const { id } = await props.params
  const r = await fleetRowRequest<DatacenterContractRow>('write', 'datacenter_contracts', id)
  if (r instanceof NextResponse) return r
  const parsed = parseContractInput(await req.json().catch(() => ({})), true)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const changed = CONTRACT_TERMS.filter(k => parsed.value[k] !== undefined && String(parsed.value[k]) !== String(r.row[k]))
  if (r.row.schedule_id && changed.length) {
    return NextResponse.json({ error: `${changed.join(', ')} cannot change once the contract is accruing; end it and create a new one` }, { status: 409 })
  }
  const end = parsed.value.end_date !== undefined ? parsed.value.end_date : r.row.end_date
  if (end && end < (parsed.value.start_date ?? r.row.start_date)) return NextResponse.json({ error: 'end_date must be on or after start_date' }, { status: 400 })
  const { data, error } = await (r.req.admin as any).from('datacenter_contracts').update({ ...parsed.value, updated_at: new Date().toISOString() })
    .eq('fund_id', r.req.fundId).eq('vehicle_id', r.req.vehicleId).eq('id', id).select('*').single()
  if (error) return NextResponse.json({ error: 'Could not save the contract' }, { status: 500 })
  return NextResponse.json(data)
}

// POST { action: 'roll', asOf? } — bring the accrual schedules up to the escalation period containing
// `asOf` (default today). Writes schedules the close books from, so `accounting` write too.
export async function POST(req: NextRequest, props: Params) {
  const { id } = await props.params
  const r = await fleetRowRequest<DatacenterContractRow>('write', 'datacenter_contracts', id)
  if (r instanceof NextResponse) return r
  const b = await req.json().catch(() => ({}))
  if (b?.action !== 'roll') return NextResponse.json({ error: "action must be 'roll'" }, { status: 400 })
  const denied = requireAccountingWrite(r.req.access)
  if (denied) return denied
  const asOf = b.asOf ?? new Date().toISOString().slice(0, 10)
  if (typeof asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return NextResponse.json({ error: 'asOf must be YYYY-MM-DD' }, { status: 400 })
  const ids = await accountIdsByCode(r.req.admin, r.req.fundId, r.req.vehicleId, [DATACENTER_CODES.expense, DATACENTER_CODES.offset])
  const result = await ensureDatacenterSchedule(r.req.admin, r.row, {
    fundId: r.req.fundId, vehicleId: r.req.vehicleId, userId: r.req.userId,
    accounts: { expense: ids.get(DATACENTER_CODES.expense)!, offset: ids.get(DATACENTER_CODES.offset)! },
  }, asOf)
  return 'error' in result ? refusal(result) : NextResponse.json(result)
}
