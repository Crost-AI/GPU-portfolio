import { describe, it, expect } from 'vitest'
import { loadK1Year } from '@/lib/accounting/k1-load'
import { loadActualBookYear, postTaxAdjustments } from '@/lib/accounting/book-tax-run'
import { buildAllocationEntry } from '@/lib/accounting/allocation-actions'
import { GPU_SPV_CHART } from '@/lib/accounting/chart'

/**
 * ── GPU fleet (P1c) ── The tax loaders read a GPU SPV's chart by subtype. Its codes collide with the
 * fund chart's (4000 is rental revenue, 5200/5250 insurance and repairs, 5300 depreciation), so a
 * code-keyed read would leave rental revenue off the K-1, propose §709 and syndication differences on
 * insurance and repairs, and book an agent "gain" to rental revenue.
 */

const ACCOUNTS = [
  ...GPU_SPV_CHART.map(a => ({ id: `a${a.code}`, code: a.code, type: a.type, subtype: a.subtype, lp_entity_id: null })),
  { id: 'cap-a', code: '3100-a', type: 'equity', subtype: 'lp_capital', lp_entity_id: 'lp-a' },
  { id: 'cap-b', code: '3100-b', type: 'equity', subtype: 'lp_capital', lp_entity_id: 'lp-b' },
]

const p = (account_id: string, amount: number, date: string, source_type: string, lp_entity_id: string | null = null) =>
  ({ account_id, amount, lp_entity_id, book: 'actual', journal_entries: { entry_date: date, status: 'posted', source_type, book: 'actual' } })

// Rental 100,000; interest 1,000; a disposal gain of 5,000; expenses on every GPU expense account,
// 5200 insurance and 5250 repairs among them. Each allocated 60/40 by the close.
const EXPENSES: [string, number][] = [['a5000', 4_000], ['a5100', 12_000], ['a5150', 3_000], ['a5200', 2_000], ['a5250', 1_500], ['a5300', 20_000], ['a5400', 2_500], ['a5900', 1_000]]
const totalExpense = EXPENSES.reduce((s, [, v]) => s + v, 0)
const POSTINGS = [
  p('a1000', 100_000, '2027-01-10', 'capital_call'), p('cap-a', -60_000, '2027-01-10', 'capital_call', 'lp-a'), p('cap-b', -40_000, '2027-01-10', 'capital_call', 'lp-b'),
  p('a1000', 101_000, '2027-06-30', 'income'), p('a4000', -100_000, '2027-06-30', 'income'), p('a4100', -1_000, '2027-06-30', 'income'),
  p('cap-a', -60_600, '2027-06-30', 'income', 'lp-a'), p('cap-b', -40_400, '2027-06-30', 'income', 'lp-b'), p('a3200', 101_000, '2027-06-30', 'income'),
  p('a1000', 5_000, '2027-09-30', 'realized_gain'), p('a4500', -5_000, '2027-09-30', 'realized_gain'),
  p('cap-a', -3_000, '2027-09-30', 'realized_gain', 'lp-a'), p('cap-b', -2_000, '2027-09-30', 'realized_gain', 'lp-b'), p('a3200', 5_000, '2027-09-30', 'realized_gain'),
  ...EXPENSES.map(([id, v]) => p(id, v, '2027-11-30', 'partnership_expense')), p('a1000', -totalExpense, '2027-11-30', 'partnership_expense'),
  p('cap-a', totalExpense * 0.6, '2027-11-30', 'partnership_expense', 'lp-a'), p('cap-b', totalExpense * 0.4, '2027-11-30', 'partnership_expense', 'lp-b'), p('a3200', -totalExpense, '2027-11-30', 'partnership_expense'),
]

const TABLES: Record<string, any[]> = {
  chart_of_accounts: ACCOUNTS,
  journal_postings: POSTINGS,
  journal_entries: [],
  fund_vehicles: [{ id: 'veh-g', fund_id: 'f', name: 'H200 SPV I', kind: 'gpu_spv', aliases: [] }],
  lp_investments: [
    { id: 'i-a', fund_id: 'f', portfolio_group: 'H200 SPV I', entity_id: 'lp-a', commitment: 60_000 },
    { id: 'i-b', fund_id: 'f', portfolio_group: 'H200 SPV I', entity_id: 'lp-b', commitment: 40_000 },
  ],
  fund_settings: [{ fund_id: 'f', currency: 'USD' }],
}

/** The same chainable read-only fake as tests/tax-vc-unchanged.test.ts: each table's rows, whatever the filters. */
function fakeAdmin() {
  const make = (rows: any[]) => {
    const q: any = {
      select: () => q, eq: () => q, neq: () => q, in: () => q, is: () => q, not: () => q, gte: () => q, lte: () => q, lt: () => q, gt: () => q,
      like: () => q, ilike: () => q, or: () => q, order: () => q, limit: () => q, contains: () => q,
      range: (from: number) => Promise.resolve({ data: from === 0 ? rows : [], error: null }),
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      then: (resolve: (v: any) => void, reject?: any) => Promise.resolve({ data: rows, error: null }).then(resolve, reject),
    }
    return q
  }
  return { from: (table: string) => make(TABLES[table] ?? []), rpc: async () => ({ data: null, error: null }) } as any
}

describe('the K-1 loader reads a GPU SPV by subtype', () => {
  it('rental is business income, every expense a business deduction, the disposal §1231, interest box 5', async () => {
    const inputs = await loadK1Year(fakeAdmin(), 'f', 'H200 SPV I', 2027)
    if ('error' in inputs) throw new Error(inputs.error)
    expect(inputs.fund).toEqual({
      interest: 1_000, ordinaryDividends: 0, qualifiedDividends: 0, shortTermGain: 0, longTermGain: 0, longTermGainWithinApiPeriod: 0,
      otherIncome: 0, deductions: 0,
      businessIncome: 100_000, businessDeductions: totalExpense, section1231Gain: 5_000,
    })
    expect(inputs.undeterminedGain).toBe(0)
    expect(inputs.notDerivable.map(n => n.line)).toEqual(['§1231 gain (10)', 'Depreciation convention'])
    const a = inputs.partners.find(x => x.lpEntityId === 'lp-a')!
    expect([a.operatingIncome, a.realizedGains, a.expenses]).toEqual([60_600, 3_000, totalExpense * 0.6])
  })
})

describe('the book-to-tax run on a GPU SPV', () => {
  it('proposes nothing for 5200 insurance or 5250 repairs', async () => {
    const loaded = await loadActualBookYear(fakeAdmin(), 'f', 'H200 SPV I', 2027)
    if ('error' in loaded) throw new Error(loaded.error)
    expect(loaded.year).toMatchObject({ organizationalExpense: 0, organizationalCostsToDate: 0, syndicationExpense: 0, unrealizedChange: 0 })
    const preview = await postTaxAdjustments(fakeAdmin(), 'f', 'H200 SPV I', 'u', 2027, { preview: true })
    if ('error' in preview) throw new Error(preview.error)
    expect(preview.proposals).toEqual([])
    expect(preview.missingAccounts).toEqual([])
  })
})

describe('the allocation actions on a GPU SPV', () => {
  it('a gain books to the disposal account and an expense to partnership expenses', async () => {
    const body = { entryDate: '2027-06-30', amount: 1_000 }
    const gain = await buildAllocationEntry(fakeAdmin(), 'f', 'H200 SPV I', { action: 'gain', ...body })
    const expense = await buildAllocationEntry(fakeAdmin(), 'f', 'H200 SPV I', { action: 'expense', ...body })
    if ('error' in gain || 'error' in expense) throw new Error('unexpected error')
    expect(gain.entry.postings.map(x => [x.accountId, x.amount])).toEqual(expect.arrayContaining([['a4500', -1_000], ['a1000', 1_000]]))
    expect(expense.entry.postings.map(x => [x.accountId, x.amount])).toEqual(expect.arrayContaining([['a5400', 1_000], ['a1000', -1_000]]))
    expect(JSON.stringify([gain, expense])).not.toMatch(/a4000|a5100/)
  })
})
