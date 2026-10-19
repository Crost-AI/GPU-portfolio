import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

// The fee true-up through the REAL intercompany register: a reduction must leave the charges
// netting to the fee, so settlement moves the net fee in cash and leaves no balance behind.

const s = vi.hoisted(() => ({ m: null as any, n: 0, rpcFails: false, rpcCalls: 0 }))
const VEHICLES: Record<string, string> = { 'GPU I': 'v1', ManCo: 'mc', 'ManCo II': 'mc2' }
vi.mock('@/lib/accounting/vehicle-id', () => ({
  vehicleIdByName: async (_a: unknown, _f: string, name: string) => VEHICLES[name] ?? null,
  vehicleNameById: async (_a: unknown, _f: string, id: string) => Object.keys(VEHICLES).find(k => VEHICLES[k] === id) ?? null,
}))
vi.mock('@/lib/accounting/persist', () => ({
  persistEntry: async (_a: unknown, fundId: string, group: string, _u: unknown, entry: any, status = 'posted') => {
    const id = `je-${++s.n}`
    s.m.tables.journal_entries.push({ id, fund_id: fundId, vehicle_id: VEHICLES[group], book: 'actual', status, entry_date: entry.entryDate, source_ref: entry.sourceRef ?? null, source_type: entry.sourceType, memo: entry.memo })
    for (const p of entry.postings) s.m.tables.journal_postings.push({ journal_entry_id: id, book: 'actual', fund_id: fundId, vehicle_id: VEHICLES[group], account_id: p.accountId, amount: p.amount })
    return { entryId: id }
  },
  liveEntryByRef: async (_a: unknown, fundId: string, vehicleId: string, ref: string) => {
    const e = s.m.tables.journal_entries.find((r: any) => r.fund_id === fundId && r.vehicle_id === vehicleId && r.source_ref === ref && r.status !== 'void')
    return e ? { id: e.id, status: e.status, entryDate: e.entry_date } : null
  },
}))

import { accrueGrossRevenueFee } from './fee'
import { postIntercompanyCharge, settleIntercompanyCharge } from '@/lib/accounting/intercompany'

const acct = (vehicle_id: string, id: string, code: string, type: string, subtype: string) => ({ id, fund_id: 'f', vehicle_id, code, name: code, type, subtype })

beforeEach(() => {
  s.n = 0
  s.m = memoryAdmin({
    fund_vehicles: [{ id: 'v1', fund_id: 'f', name: 'GPU I', kind: 'gpu_spv' }, { id: 'mc', fund_id: 'f', name: 'ManCo', kind: 'manco' }, { id: 'mc2', fund_id: 'f', name: 'ManCo II', kind: 'manco' }],
    chart_of_accounts: [
      acct('v1', 'cash', '1000', 'asset', 'cash'), acct('v1', 'rev', '4000', 'income', 'rental_revenue'),
      acct('v1', 'fee', '5000', 'expense', 'management_fee'), acct('v1', 'dtm', '2100', 'liability', 'due_to_gp'),
      acct('mc', 'mc-cash', '1000', 'asset', 'cash'), acct('mc', 'mc-income', '4000', 'income', 'management_fee_income'),
      acct('mc2', 'mc2-cash', '1000', 'asset', 'cash'), acct('mc2', 'mc2-income', '4000', 'income', 'management_fee_income'),
    ],
    journal_entries: [{ id: 'e-rev', fund_id: 'f', vehicle_id: 'v1', book: 'actual', status: 'posted', entry_date: '2027-01-15', source_type: 'income', source_ref: null }],
    journal_postings: [
      { journal_entry_id: 'e-rev', book: 'actual', fund_id: 'f', vehicle_id: 'v1', account_id: 'cash', amount: 100_000 },
      { journal_entry_id: 'e-rev', book: 'actual', fund_id: 'f', vehicle_id: 'v1', account_id: 'rev', amount: -100_000 },
    ],
    intercompany_transactions: [],
    vehicle_fee_terms: [{ fund_id: 'f', vehicle_id: 'v1', basis: 'gross_revenue', annual_rate: 0.05, revenue_subtypes: ['rental_revenue'], frequency: 'monthly', payee_vehicle_id: 'mc', effective_from: '2027-01-01', effective_to: null }],
  })
  s.rpcFails = false
  s.rpcCalls = 0
  // void_intercompany_charge, as the migration defines it: all or nothing.
  s.m.admin.rpc = async (name: string, args: any) => {
    if (name !== 'void_intercompany_charge') return { data: null, error: { message: `rpc ${name} unsupported` } }
    s.rpcCalls++
    const c = s.m.tables.intercompany_transactions.find((r: any) => r.id === args.p_charge_id && r.fund_id === args.p_fund_id)
    if (!c) return { data: null, error: { message: 'Charge not found' } }
    if (c.status !== 'accrued' || c.from_settlement_entry_id || c.to_settlement_entry_id) return { data: null, error: { message: 'only an unsettled charge can be voided' } }
    if (s.rpcFails) return { data: null, error: { message: 'closed period on ManCo' } }
    for (const e of s.m.tables.journal_entries) if (e.id === c.from_entry_id || e.id === c.to_entry_id) Object.assign(e, { status: 'void', posted_at: null })
    c.status = 'void'
    return { data: null, error: null }
  }
})

/** Balance of each account by vehicle and code, over live entries only. */
function balances(): Record<string, number> {
  const live = new Set(s.m.tables.journal_entries.filter((e: any) => e.status !== 'void').map((e: any) => e.id))
  const byId = new Map(s.m.tables.chart_of_accounts.map((a: any) => [a.id, `${a.vehicle_id}:${a.code}`]))
  const out: Record<string, number> = {}
  for (const p of s.m.tables.journal_postings) {
    if (!live.has(p.journal_entry_id)) continue
    const key = byId.get(p.account_id) as string
    out[key] = Math.round(((out[key] ?? 0) + p.amount) * 100) / 100
  }
  return out
}
const ic = (b: Record<string, number>) => Object.entries(b).filter(([k]) => /:(19|29)00-/.test(k)).map(([, v]) => v)
const reverseRevenue = (amount: number) => {
  s.m.tables.journal_entries.push({ id: 'e-rev-rev', fund_id: 'f', vehicle_id: 'v1', book: 'actual', status: 'posted', entry_date: '2027-01-25', source_type: 'income', source_ref: null })
  s.m.tables.journal_postings.push(
    { journal_entry_id: 'e-rev-rev', book: 'actual', fund_id: 'f', vehicle_id: 'v1', account_id: 'cash', amount: -amount },
    { journal_entry_id: 'e-rev-rev', book: 'actual', fund_id: 'f', vehicle_id: 'v1', account_id: 'rev', amount },
  )
}
const live = (kind?: string) => s.m.tables.intercompany_transactions.filter((c: any) => c.status !== 'void' && (!kind || c.kind === kind))

describe('a fee reduction through the intercompany register', () => {
  it('accrue 5,000 → reduce 1,000 → settle: the unsettled charge is re-issued net, 4,000 moves, nothing is left owed', async () => {
    expect(await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')).toMatchObject({ delta: 5_000 })
    reverseRevenue(20_000)
    expect(await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')).toMatchObject({ delta: -1_000 })
    expect(live().map((c: any) => [c.kind, c.amount])).toEqual([['management_fee', 4_000]])
    expect(s.m.tables.intercompany_transactions.filter((c: any) => c.status === 'void')).toHaveLength(1)
    let b = balances()
    expect(b['v1:5000']).toBe(4_000)
    expect(b['mc:4000']).toBe(-4_000)
    expect(await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')).toEqual({ delta: 0 })

    expect(await settleIntercompanyCharge(s.m.admin, 'f', 'u', live()[0].id, '2027-02-10')).toEqual({ ok: true })
    b = balances()
    expect(b['v1:1000']).toBe(80_000 - 4_000)
    expect(b['mc:1000']).toBe(4_000)
    expect(ic(b).every(v => v === 0)).toBe(true)
  })

  it('accrue → settle → reduce: a 1,000 rebate charge is raised and settles back', async () => {
    await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')
    expect(await settleIntercompanyCharge(s.m.admin, 'f', 'u', live('management_fee')[0].id, '2027-02-10')).toEqual({ ok: true })
    reverseRevenue(20_000)
    expect(await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')).toMatchObject({ delta: -1_000 })
    const [rebate] = live('management_fee_rebate')
    expect(rebate).toMatchObject({ amount: 1_000, from_vehicle_id: 'mc', to_vehicle_id: 'v1', status: 'accrued' })
    let b = balances()
    expect(b['v1:5000']).toBe(4_000)
    expect(b['mc:4000']).toBe(-4_000)
    expect(await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')).toEqual({ delta: 0 })

    expect(await settleIntercompanyCharge(s.m.admin, 'f', 'u', rebate.id, '2027-03-10')).toEqual({ ok: true })
    b = balances()
    expect(b['v1:1000']).toBe(80_000 - 5_000 + 1_000)
    expect(b['mc:1000']).toBe(4_000)
    expect(ic(b).every(v => v === 0)).toBe(true)
  })
})

describe('the true-up finds only its own charges', () => {
  it('a hand-raised charge tagged in its memo, or one to another counterparty, is neither counted nor voided', async () => {
    const spv = { vehicleId: 'v1', name: 'GPU I' }
    // Same counterparties, the fee tag pasted into the memo, but raised by hand (no source_ref).
    const byHand = await postIntercompanyCharge(s.m.admin, {
      fundId: 'f', userId: 'u', kind: 'management_fee', chargeDate: '2027-01-31', amount: 700,
      memo: 'Extra fee [gpu-fee:v1:2027-01]', payer: spv, payee: { vehicleId: 'mc', name: 'ManCo' },
    })
    // The fee's source_ref, but owed to a different management company.
    const elsewhere = await postIntercompanyCharge(s.m.admin, {
      fundId: 'f', userId: 'u', kind: 'management_fee', chargeDate: '2027-01-31', amount: 300,
      memo: 'Fee', payer: spv, payee: { vehicleId: 'mc2', name: 'ManCo II' }, sourceRef: 'gpu-fee:v1:2027-01',
    })
    if ('error' in byHand || 'error' in elsewhere) throw new Error('setup')

    expect(await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')).toMatchObject({ delta: 5_000 })
    reverseRevenue(20_000)
    expect(await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')).toMatchObject({ delta: -1_000 })

    const status = (id: string) => s.m.tables.intercompany_transactions.find((c: any) => c.id === id).status
    expect(status(byHand.id)).toBe('accrued')
    expect(status(elsewhere.id)).toBe('accrued')
    const fees = s.m.tables.intercompany_transactions.filter((c: any) => c.source_ref === 'gpu-fee:v1:2027-01' && c.to_vehicle_id === 'mc')
    expect(fees.map((c: any) => [c.status, c.amount])).toEqual([['void', 5_000], ['accrued', 4_000]])
    expect(await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')).toEqual({ delta: 0 })
  })
})

describe('the reduction void is atomic and retry-safe', () => {
  it('a failure inside the void leaves the charge and both entries as they were, and the retry nets cleanly', async () => {
    await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')
    const [original] = live('management_fee')
    reverseRevenue(20_000)
    s.rpcFails = true
    expect(await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')).toEqual({ error: expect.stringMatching(/could not be voided: closed period/) })
    expect(live('management_fee').map((c: any) => [c.id, c.status, c.amount])).toEqual([[original.id, 'accrued', 5_000]])
    expect(s.m.tables.journal_entries.filter((e: any) => [original.from_entry_id, original.to_entry_id].includes(e.id)).map((e: any) => e.status)).toEqual(['posted', 'posted'])
    s.rpcFails = false
    expect(await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')).toMatchObject({ delta: -1_000 })
    expect(live('management_fee').map((c: any) => c.amount)).toEqual([4_000])
    expect(balances()['v1:5000']).toBe(4_000)
  })

  it('refuses to build on a half-voided charge: accrued, but its SPV entry is not on the books', async () => {
    await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')
    const [charge] = live('management_fee')
    s.m.tables.journal_entries.find((e: any) => e.id === charge.from_entry_id).status = 'void'
    const out = await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')
    expect(out).toEqual({ error: expect.stringMatching(new RegExp(`charge ${charge.id} is accrued but GPU I's entry for it is not on the books`)) })
    expect(live()).toHaveLength(1)
  })

  it('a charge with one settlement side linked is treated as paid: rebated, never voided', async () => {
    await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')
    const [charge] = live('management_fee')
    charge.to_settlement_entry_id = 'settle-half'
    reverseRevenue(20_000)
    expect(await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')).toMatchObject({ delta: -1_000 })
    expect(s.rpcCalls).toBe(0)
    expect(live('management_fee_rebate').map((c: any) => c.amount)).toEqual([1_000])
    expect(charge.status).toBe('accrued')
  })

  it('records the void in the audit trail with its entry ids', async () => {
    await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')
    const [charge] = live('management_fee')
    reverseRevenue(20_000)
    await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')
    const audit = (s.m.tables.accounting_audit_events ?? []).find((r: any) => r.action === 'intercompany.void')
    expect(audit).toMatchObject({ subject_id: charge.id, reason: 'gpu fee true-up gpu-fee:v1:2027-01' })
    expect(audit.details.entryIds).toEqual([charge.from_entry_id, charge.to_entry_id])
  })
})
