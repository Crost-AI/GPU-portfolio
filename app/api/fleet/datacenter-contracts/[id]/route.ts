import { NextRequest, NextResponse } from 'next/server'
import { accountIdsByCode } from '@/lib/gpu/assets'
import { fleetRowRequest, refusal, requireAccountingWrite } from '@/lib/gpu/http'
import { CONTRACT_TERMS, DATACENTER_CODES, contractDatesError, endDatacenterSchedules, ensureDatacenterSchedule, parseContractInput } from '@/lib/gpu/opex'
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
// leave posted months on the old terms); end it and create a new contract instead. Ending it ends
// its accrual schedules at the contract end; an ended contract is not reopened or extended.
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
  // An ended (or fixed-term, accruing) contract is not reopened or extended: its schedules end at the
  // old end, and silently leaving them stopped would understate the accrual. Create a new contract.
  const reopening = (r.row.status === 'ended' && parsed.value.status === 'active')
    || (!!r.row.end_date && !!r.row.schedule_id && parsed.value.end_date !== undefined && (parsed.value.end_date === null || parsed.value.end_date > r.row.end_date))
  if (reopening) return NextResponse.json({ error: 'An ended contract cannot be reopened or extended; create a new contract for the new term' }, { status: 409 })
  const merged = { ...r.row, ...parsed.value }
  const dates = contractDatesError(merged)
  if (dates) return NextResponse.json({ error: dates }, { status: 400 })
  if (merged.status === 'ended' && !merged.end_date) return NextResponse.json({ error: 'end_date is required to end a contract' }, { status: 400 })
  // A contract with an end has its schedules reconciled to it on EVERY save, not only when the end
  // changes, so a termination whose schedule write failed is repaired by the identical retry.
  // Changing accruals writes what the close books from: `accounting` write, whenever there is work.
  const pending = merged.end_date ? await endDatacenterSchedules(r.req.admin, r.req, id, merged.end_date, { dryRun: true }) : 0
  const ending = (merged.status === 'ended' && r.row.status !== 'ended')
    || (parsed.value.end_date != null && (!r.row.end_date || parsed.value.end_date < r.row.end_date))
  if (ending || pending > 0) {
    const denied = requireAccountingWrite(r.req.access)
    if (denied) return denied
  }
  const { data, error } = await (r.req.admin as any).from('datacenter_contracts').update({ ...parsed.value, updated_at: new Date().toISOString() })
    .eq('fund_id', r.req.fundId).eq('vehicle_id', r.req.vehicleId).eq('id', id).select('*').single()
  if (error) return NextResponse.json({ error: 'Could not save the contract' }, { status: 500 })
  const schedulesEnded = merged.end_date ? await endDatacenterSchedules(r.req.admin, r.req, id, merged.end_date) : 0
  return NextResponse.json({ ...data, schedulesEnded })
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
  if ('error' in result) return refusal(result)
  // A contract with an end keeps its schedules ended there (also repairs a failed termination).
  const schedulesEnded = r.row.end_date ? await endDatacenterSchedules(r.req.admin, r.req, id, r.row.end_date) : 0
  return NextResponse.json({ ...result, schedulesEnded })
}
