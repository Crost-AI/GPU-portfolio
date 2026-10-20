import { describe, it, expect } from 'vitest'
import { loadK1Year } from '@/lib/accounting/k1-load'
import { loadActualBookYear, postTaxAdjustments } from '@/lib/accounting/book-tax-run'
import { buildAllocationEntry } from '@/lib/accounting/allocation-actions'
import { GPU_SPV_CHART } from '@/lib/accounting/chart'
import { allocateK1, k1CategoriesIn } from '@/lib/accounting/k1-allocation'
import { buildK1Html } from '@/lib/tax/k1-pdf'
import { buildK1Workbook } from '@/lib/tax/k1-workbook'
import * as XLSX from 'xlsx'

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
    expect(inputs.notDerivable.map(n => n.line)).toEqual(['§1231 gain (10)', 'Ordinary business income (1)', 'Depreciation convention'])
    const a = inputs.partners.find(x => x.lpEntityId === 'lp-a')!
    expect([a.operatingIncome, a.realizedGains, a.expenses]).toEqual([60_600, 3_000, totalExpense * 0.6])
  })
})

describe('box 1 and box 10 on a GPU SPV K-1', () => {
  it('are present, follow their buckets and tie to the capital account with zero variance', async () => {
    const inputs = await loadK1Year(fakeAdmin(), 'f', 'H200 SPV I', 2027)
    if ('error' in inputs) throw new Error(inputs.error)
    const { partners, unallocated } = allocateK1(inputs)
    expect(unallocated).toEqual({})
    const a = partners.find(p => p.lpEntityId === 'lp-a')!
    const b = partners.find(p => p.lpEntityId === 'lp-b')!
    // Box 1: 60% of rental 100,000 less 60% of 46,000 of expenses; box 10: 60% of the 5,000 gain.
    expect(a.lines).toMatchObject({ ordinaryBusinessIncome: 32_400, section1231Gain: 3_000, interest: 600, deductions: 0 })
    expect(b.lines).toMatchObject({ ordinaryBusinessIncome: 21_600, section1231Gain: 2_000, interest: 400, deductions: 0 })
    for (const p of [a, b]) {
      expect(p.tieOut.variance).toBe(0)
      expect(k1CategoriesIn(p.lines).slice(0, 1)).toEqual(['ordinaryBusinessIncome'])
      expect(k1CategoriesIn(p.lines)).toContain('section1231Gain')
    }
    const html = buildK1Html({ fundName: 'F', fundLogo: null, fundAddress: null, vehicle: 'H200 SPV I', taxYear: 2027, version: 1, status: 'draft', partnerName: 'lp-a', lines: a.lines, capitalAccount: { beginning: 0, contributions: 0, distributions: 0, netIncome: 0, ending: 0 } })
    expect(html).toContain('Ordinary business income (loss)')
    expect(html).toContain('Net section 1231 gain (loss)')
    const wb = buildK1Workbook({ fundName: 'F', vehicle: 'H200 SPV I', taxYear: 2027, version: 1, status: 'draft', generatedAt: '2028-01-01T00:00:00Z', fundCharacter: null, warnings: [],
      partners: partners.map(p => ({ lpEntityId: p.lpEntityId, name: p.lpEntityId, lines: p.lines, capitalAccount: p.capitalAccount, tieOutVariance: 0, rollForwardVariance: 0 })) })
    const sheet = XLSX.utils.sheet_to_json(wb.Sheets['K-1 lines'], { header: 1 }) as any[][]
    expect(sheet[0]).toEqual(expect.arrayContaining(['Ordinary business income (loss) (box 1)', 'Net section 1231 gain (loss) (box 10)']))
  })
})

describe('carry on a GPU SPV moves box 1 and box 10 character', () => {
  it('a carry recipient reports the business income and §1231 gain it was allocated, and nothing is lost', () => {
    const zero = { beginningCapital: 0, contributions: 0, distributions: 0, carriedInterest: 0, endingCapital: 0 }
    const { partners, unallocated } = allocateK1({
      fund: { interest: 0, ordinaryDividends: 0, qualifiedDividends: 0, shortTermGain: 0, longTermGain: 0, longTermGainWithinApiPeriod: 0, otherIncome: 0, deductions: 0,
        businessIncome: 10_000, businessDeductions: 2_000, section1231Gain: 2_000 },
      partners: [
        { ...zero, lpEntityId: 'lp', operatingIncome: 10_000, realizedGains: 2_000, expenses: 2_000, carriedInterest: 2_000 },
        { ...zero, lpEntityId: 'gp', operatingIncome: 0, realizedGains: 0, expenses: 0, carriedInterest: -2_000 },
      ],
    })
    expect(unallocated).toEqual({})
    const gp = partners.find(p => p.lpEntityId === 'gp')!
    // Profit pool: box 1 8,000 and box 10 2,000, so 2,000 of carry is 1,600 of box 1 and 400 of box 10.
    expect(gp.lines).toMatchObject({ ordinaryBusinessIncome: 1_600, section1231Gain: 400 })
    for (const p of partners) expect(p.tieOut.variance).toBe(0)
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

describe('organizational and syndication costs on 5400 are flagged on box 1 (§709)', () => {
  it('a year with 5400 activity carries a note saying box 1 deducts it in full and what the preparer splits out', async () => {
    const inputs = await loadK1Year(fakeAdmin(), 'f', 'H200 SPV I', 2027)
    if ('error' in inputs) throw new Error(inputs.error)
    const note = inputs.notDerivable.find(n => n.line === 'Ordinary business income (1)')
    expect(note?.reason).toMatch(/2500\.00 of professional and organizational costs \(5400\)/)
    expect(note?.reason).toMatch(/§709/)
    expect(note?.reason).toMatch(/syndication costs are not deductible/)
  })

  it('no 5400 activity, no note', async () => {
    const saved = TABLES.journal_postings
    TABLES.journal_postings = saved.filter(x => x.account_id !== 'a5400')
    try {
      const inputs = await loadK1Year(fakeAdmin(), 'f', 'H200 SPV I', 2027)
      if ('error' in inputs) throw new Error(inputs.error)
      expect(inputs.notDerivable.map(n => n.line)).not.toContain('Ordinary business income (1)')
    } finally {
      TABLES.journal_postings = saved
    }
  })
})

describe('the GPU branches fail closed when the vehicle kind cannot be read', () => {
  // The kind read (fund_vehicles, select 'kind') errors; every other read succeeds. A loader that
  // took the error for "not a GPU SPV" would read the GPU chart by fund-chart codes.
  const kindReadFails = () => {
    const base = fakeAdmin()
    const failing: any = new Proxy({}, {
      get: (_t, k) => k === 'then' ? undefined
        : k === 'maybeSingle' ? () => Promise.resolve({ data: null, error: { message: 'statement timeout' } })
        : () => failing,
    })
    return { ...base, from: (table: string) => {
      const q = base.from(table)
      return table === 'fund_vehicles' ? { ...q, select: (cols: string) => (cols === 'kind' ? failing : q.select(cols)) } : q
    } }
  }

  it('the K-1 loader refuses', async () => {
    const r = await loadK1Year(kindReadFails() as any, 'f', 'H200 SPV I', 2027)
    expect(r).toEqual({ error: expect.stringMatching(/Could not read the kind of "H200 SPV I"/) })
  })

  it('the book-to-tax year refuses, and so does the run', async () => {
    expect(await loadActualBookYear(kindReadFails() as any, 'f', 'H200 SPV I', 2027)).toEqual({ error: expect.stringMatching(/Could not read the kind/) })
    expect(await postTaxAdjustments(kindReadFails() as any, 'f', 'H200 SPV I', 'u', 2027, { preview: true })).toEqual({ error: expect.stringMatching(/Could not read the kind/) })
  })

  it('the allocation actions refuse rather than book to 4000 or 5100', async () => {
    for (const action of ['gain', 'expense']) {
      const r = await buildAllocationEntry(kindReadFails() as any, 'f', 'H200 SPV I', { action, entryDate: '2027-06-30', amount: 1_000 })
      expect(r).toEqual({ error: expect.stringMatching(/Could not read the kind/) })
    }
  })
})
