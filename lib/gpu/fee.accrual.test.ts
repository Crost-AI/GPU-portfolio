import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

// The close's gross-revenue fee true-up, on both booking paths: Dr 5000 / Cr 2100 with no payee,
// an intercompany charge to the management company with one.

const s = vi.hoisted(() => ({ m: null as any, n: 0, failGroup: null as string | null }))
vi.mock('@/lib/accounting/vehicle-id', () => ({
  vehicleIdByName: async (_a: unknown, _f: string, name: string) => ({ 'GPU I': 'v1', ManCo: 'mc' } as Record<string, string>)[name] ?? null,
  vehicleNameById: async (_a: unknown, _f: string, id: string) => ({ v1: 'GPU I', mc: 'ManCo' } as Record<string, string>)[id] ?? null,
}))
const book = (group: string, entry: any, status = 'posted') => {
  const id = `fee-${++s.n}`
  s.m.tables.journal_entries.push({ id, fund_id: 'f', vehicle_id: group === 'ManCo' ? 'mc' : 'v1', book: 'actual', status, entry_date: entry.entryDate, source_ref: entry.sourceRef ?? null, source_type: entry.sourceType, memo: entry.memo })
  for (const p of entry.postings) s.m.tables.journal_postings.push({ journal_entry_id: id, book: 'actual', fund_id: 'f', account_id: p.accountId, amount: p.amount })
  return id
}
const persistEntry = vi.fn(async (_a: unknown, _f: string, group: string, _u: unknown, entry: any, status = 'posted') => {
  if (s.failGroup === group) return { error: 'closed period' }
  return { entryId: book(group, entry, status) }
})
vi.mock('@/lib/accounting/persist', () => ({ persistEntry: (...a: any[]) => (persistEntry as any)(...a) }))
const postIntercompanyCharge = vi.fn(async (_a: unknown, args: any) => {
  const id = `ic-${s.m.tables.intercompany_transactions.length + 1}`
  s.m.tables.intercompany_transactions.push({ id, fund_id: 'f', from_vehicle_id: args.payer.vehicleId, to_vehicle_id: args.payee.vehicleId, kind: args.kind, status: 'accrued', memo: args.memo, amount: args.amount, source_ref: args.sourceRef ?? null })
  book('GPU I', { entryDate: args.chargeDate, sourceRef: `intercompany:${id}`, sourceType: 'intercompany', postings: [{ accountId: 'fee', amount: args.amount }, { accountId: 'ic-pay', amount: -args.amount }] })
  book('ManCo', { entryDate: args.chargeDate, sourceRef: `intercompany:${id}`, sourceType: 'intercompany', postings: [{ accountId: 'ic-rec', amount: args.amount }, { accountId: 'mc-income', amount: -args.amount }] })
  return { id }
})
const unwindIntercompanyEntry = vi.fn(async () => null)
vi.mock('@/lib/accounting/intercompany', async orig => ({
  ...(await orig<any>()),
  postIntercompanyCharge: (...a: any[]) => (postIntercompanyCharge as any)(...a),
  ensureIntercompanyAccounts: async () => ({ receivableAccountId: 'ic-rec', payableAccountId: 'ic-pay' }),
  resolveSideAccounts: async (_a: unknown, _f: string, _g: string, _k: string, side: string, icId: string) =>
    side === 'payer' ? { intercompanyAccountId: icId, cashAccountId: 'cash', pnlAccountId: 'fee' } : { intercompanyAccountId: icId, cashAccountId: 'mc-cash', pnlAccountId: 'mc-income' },
  unwindIntercompanyEntry: (...a: any[]) => (unwindIntercompanyEntry as any)(...a),
}))

import { accrueGrossRevenueFee } from './fee'

const chart = [
  { id: 'cash', code: '1000', subtype: 'cash' },
  { id: 'rev', code: '4000', subtype: 'rental_revenue' },
  { id: 'int', code: '4100', subtype: 'interest_income' },
  { id: 'disp', code: '4500', subtype: 'disposal_gain' },
  { id: 'fee', code: '5000', subtype: 'management_fee' },
  { id: 'dtm', code: '2100', subtype: 'due_to_gp' },
].map(a => ({ ...a, fund_id: 'f', vehicle_id: 'v1' }))

const income = (id: string, accountId: string, amount: number, entryDate: string, status = 'posted') => ({
  entry: { id, fund_id: 'f', vehicle_id: 'v1', book: 'actual', status, entry_date: entryDate, source_type: 'income', source_ref: null },
  postings: [
    { journal_entry_id: id, book: 'actual', fund_id: 'f', account_id: 'cash', amount },
    { journal_entry_id: id, book: 'actual', fund_id: 'f', account_id: accountId, amount: -amount },
  ],
})

function seed(payee: string | null, extra: Record<string, unknown> = {}, opts: { maxRows?: number } = {}) {
  const rows = [
    income('e-rev', 'rev', 100_000, '2027-01-15'),
    income('e-int', 'int', 1_000, '2027-01-31'),     // interest: never in the basis
    income('e-disp', 'disp', 50_000, '2027-01-31'),  // disposal: never in the basis
    income('e-draft', 'rev', 7_000, '2027-01-20', 'draft'),
    income('e-feb', 'rev', 30_000, '2027-02-01'),
  ]
  s.m = memoryAdmin({
    chart_of_accounts: chart,
    journal_entries: rows.map(r => r.entry),
    journal_postings: rows.flatMap(r => r.postings),
    intercompany_transactions: [],
    vehicle_fee_terms: [{ fund_id: 'f', vehicle_id: 'v1', basis: 'gross_revenue', annual_rate: 0.05, revenue_subtypes: ['rental_revenue'], frequency: 'monthly', payee_vehicle_id: payee, effective_from: '2027-01-01', effective_to: null, ...extra }],
  }, opts)
}
const reverseRevenue = (amount: number) => {
  const r = income('e-rev-rev', 'rev', -amount, '2027-01-25')
  s.m.tables.journal_entries.push(r.entry)
  s.m.tables.journal_postings.push(...r.postings)
}
const entryPostings = (id: string) => s.m.tables.journal_postings.filter((p: any) => p.journal_entry_id === id).map((p: any) => [p.account_id, p.amount])
const balanced = (id: string) => s.m.tables.journal_postings.filter((p: any) => p.journal_entry_id === id).reduce((t: number, p: any) => t + p.amount, 0) === 0

beforeEach(() => { s.n = 0; s.failGroup = null; persistEntry.mockClear(); postIntercompanyCharge.mockClear(); unwindIntercompanyEntry.mockClear() })

describe('accrueGrossRevenueFee without a payee: Dr 5000 / Cr 2100', () => {
  it('books 5% of posted rental revenue only, once', async () => {
    seed(null)
    const first = await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')
    expect(first).toEqual({ entryId: 'fee-1', delta: 5_000 })
    expect(entryPostings('fee-1')).toEqual([['fee', 5_000], ['dtm', -5_000]])
    expect(balanced('fee-1')).toBe(true)
    expect(s.m.tables.journal_entries.find((e: any) => e.id === 'fee-1')).toMatchObject({ source_ref: 'gpu-fee:v1:2027-01', source_type: 'management_fee', entry_date: '2027-01-31' })
    expect(await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')).toEqual({ delta: 0 })
    expect(persistEntry).toHaveBeenCalledTimes(1)
  })

  it('a reversed revenue entry reduces the fee on the next run, and then holds', async () => {
    seed(null)
    await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')
    reverseRevenue(20_000)
    expect(await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')).toEqual({ entryId: 'fee-2', delta: -1_000 })
    expect(entryPostings('fee-2')).toEqual([['dtm', 1_000], ['fee', -1_000]])
    expect(await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')).toEqual({ delta: 0 })
  })

  it('posts nothing without gross-revenue terms, or outside their dates', async () => {
    seed(null, { basis: 'committed' })
    expect(await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')).toEqual({ delta: 0 })
    seed(null, { effective_from: '2027-02-01' })
    expect(await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')).toEqual({ delta: 0 })
    expect(persistEntry).not.toHaveBeenCalled()
  })
})

describe('accrueGrossRevenueFee on a busy month', () => {
  it('reads the complete basis and the complete booked sum: > 1000 postings, > 200 entries each side', async () => {
    // PostgREST's max_rows, so a read that does not page is visibly short.
    seed(null, {}, { maxRows: 1000 })
    // 1,200 more revenue entries of 100 each in January: more entries than one page returns, and
    // far more ids than one .in() chunk (200) may carry.
    for (let i = 0; i < 1_200; i++) {
      const r = income(`busy-${i}`, 'rev', 100, '2027-01-10')
      s.m.tables.journal_entries.push(r.entry)
      s.m.tables.journal_postings.push(...r.postings)
    }
    // And 250 fee entries of 10 already booked under the month's ref: the booked side crosses a chunk too.
    for (let i = 0; i < 250; i++) {
      const id = `booked-${i}`
      s.m.tables.journal_entries.push({ id, fund_id: 'f', vehicle_id: 'v1', book: 'actual', status: 'posted', entry_date: '2027-01-31', source_type: 'management_fee', source_ref: 'gpu-fee:v1:2027-01' })
      s.m.tables.journal_postings.push(
        { journal_entry_id: id, book: 'actual', fund_id: 'f', account_id: 'fee', amount: 10 },
        { journal_entry_id: id, book: 'actual', fund_id: 'f', account_id: 'dtm', amount: -10 },
      )
    }
    const inSizes: number[] = []
    const from = s.m.admin.from.bind(s.m.admin)
    s.m.admin.from = (table: string) => {
      const q = from(table)
      const inner = q.in
      q.in = (k: string, vs: unknown[]) => { if (k === 'journal_entry_id') inSizes.push(vs.length); return inner(k, vs) }
      return q
    }
    expect(await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')).toMatchObject({ delta: 5_000 + 0.05 * 120_000 - 2_500 })
    expect(Math.max(...inSizes)).toBeLessThanOrEqual(200)
  })

  it('returns a failed read as an error, so the close can unwind', async () => {
    seed(null)
    s.m.failNext('journal_postings', 'select', 'statement timeout')
    expect(await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')).toEqual({ error: expect.stringMatching(/statement timeout/) })
    expect(persistEntry).not.toHaveBeenCalled()
  })
})

describe('accrueGrossRevenueFee with a payee management company: intercompany', () => {
  it('charges the manco the delta, tagged with the month, once', async () => {
    seed('mc')
    expect(await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')).toEqual({ entryId: 'ic-1', delta: 5_000 })
    const args = postIntercompanyCharge.mock.calls[0][1] as any
    expect(args).toMatchObject({ kind: 'management_fee', amount: 5_000, chargeDate: '2027-01-31', payer: { vehicleId: 'v1', name: 'GPU I' }, payee: { vehicleId: 'mc', name: 'ManCo' } })
    expect(args.sourceRef).toBe('gpu-fee:v1:2027-01')
    expect(args.memo).not.toContain('gpu-fee:')
    expect(await accrueGrossRevenueFee(s.m.admin, 'f', 'GPU I', 'u', '2027-01')).toEqual({ delta: 0 })
    expect(postIntercompanyCharge).toHaveBeenCalledTimes(1)
  })
})
