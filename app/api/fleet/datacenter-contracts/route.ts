import { NextRequest, NextResponse } from 'next/server'
import { fetchAllRows } from '@/lib/accounting/load'
import { accountIdsByCode } from '@/lib/gpu/assets'
import { fleetRequest, requireAccountingWrite } from '@/lib/gpu/http'
import { DATACENTER_CODES, ensureDatacenterSchedule, parseContractInput } from '@/lib/gpu/opex'
import type { DatacenterContractRow } from '@/lib/gpu/types'

// ── GPU fleet (P1) ── A GPU SPV's datacenter contracts (`fleet` domain). POST creates the contract
// and, unless `schedule: false`, its monthly accrual schedule (Dr 5100 / Cr 2000) through today,
// which also needs `accounting` write; the close then proposes each month's draft.

export async function GET(req: NextRequest) {
  const r = await fleetRequest('read', req.nextUrl.searchParams.get('group'))
  if (r instanceof NextResponse) return r
  const contracts = await fetchAllRows((from, to) => (r.admin as any).from('datacenter_contracts').select('*')
    .eq('fund_id', r.fundId).eq('vehicle_id', r.vehicleId).order('start_date').range(from, to))
  return NextResponse.json({ contracts })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const r = await fleetRequest('write', body?.group)
  if (r instanceof NextResponse) return r
  const schedule = body?.schedule !== false
  if (schedule) {
    const denied = requireAccountingWrite(r.access)
    if (denied) return denied
  }
  const parsed = parseContractInput(body, false)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const { data: contract, error } = await (r.admin as any).from('datacenter_contracts')
    .insert({ ...parsed.value, fund_id: r.fundId, vehicle_id: r.vehicleId, created_by: r.userId }).select('*').single()
  if (error) return NextResponse.json({ error: 'Could not save the contract' }, { status: 500 })
  if (!schedule) return NextResponse.json({ contract }, { status: 201 })

  const ids = await accountIdsByCode(r.admin, r.fundId, r.vehicleId, [DATACENTER_CODES.expense, DATACENTER_CODES.offset])
  const result = await ensureDatacenterSchedule(r.admin, contract as DatacenterContractRow, {
    fundId: r.fundId, vehicleId: r.vehicleId, userId: r.userId,
    accounts: { expense: ids.get(DATACENTER_CODES.expense)!, offset: ids.get(DATACENTER_CODES.offset)! },
  }, new Date().toISOString().slice(0, 10))
  // The contract is saved either way; a refused schedule is retried with POST …/[id] { action: 'roll' }.
  if ('error' in result) return NextResponse.json({ contract, scheduleError: result }, { status: 201 })
  return NextResponse.json({ contract: { ...contract, schedule_id: result.scheduleId }, schedule: result }, { status: 201 })
}
