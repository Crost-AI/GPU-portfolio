import { describe, it, expect } from 'vitest'
import { parseQbTrialBalance, compareTrialBalance } from './tie-out'
import { trialBalance, type TrialBalance } from '@/lib/accounting/statements'
import type { Account } from '@/lib/accounting/types'

const TB_TEXT = [
  'Account,Debit,Credit',
  'Bank:Operating,"250,000.00",',
  'Investments:Acme Ventures III,"3,000,000.00",',
  "Partners' Capital,,\"3,250,000.00\"",
  'TOTAL,"3,250,000.00","3,250,000.00"',
].join('\n')

const MAPPING = new Map([
  ['Bank:Operating', '1000'],
  ['Investments:Acme Ventures III', '1100'],
  ["Partners' Capital", '3100'],
])

const ours = (rows: { code: string; name: string; balance: number }[]) =>
  ({ rows: rows.map(row => ({ ...row, debit: Math.max(row.balance, 0), credit: Math.max(-row.balance, 0) })),
    totalDebits: 0, totalCredits: 0, balanced: true }) as unknown as TrialBalance

describe('parseQbTrialBalance', () => {
  it('parses accounts and drops the total row', () => {
    const { rows, errors } = parseQbTrialBalance(TB_TEXT)
    expect(errors).toEqual([])
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({ account: 'Bank:Operating', debit: 250_000, credit: 0 })
  })

  it('reports a missing column rather than guessing', () => {
    const { rows, errors } = parseQbTrialBalance('Account\nBank:Operating')
    expect(rows).toEqual([])
    expect(errors.join(' ')).toMatch(/debit|credit/i)
  })
})

describe('compareTrialBalance', () => {
  const theirs = parseQbTrialBalance(TB_TEXT).rows

  it('ties when every mapped account agrees', () => {
    const result = compareTrialBalance(
      ours([
        { code: '1000', name: 'Cash', balance: 250_000 },
        { code: '1100', name: 'Investments at cost', balance: 3_000_000 },
        { code: '3100', name: "Partners' capital", balance: -3_250_000 },
      ]),
      theirs,
      MAPPING,
    )
    expect(result.ties).toBe(true)
    expect(result.lines).toEqual([])
  })

  it('reports the account and the amount when one differs', () => {
    const result = compareTrialBalance(
      ours([
        { code: '1000', name: 'Cash', balance: 240_000 },
        { code: '1100', name: 'Investments at cost', balance: 3_000_000 },
        { code: '3100', name: "Partners' capital", balance: -3_250_000 },
      ]),
      theirs,
      MAPPING,
    )
    expect(result.ties).toBe(false)
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0]).toMatchObject({ code: '1000', ours: 240_000, theirs: 250_000, difference: -10_000 })
  })

  it('reports an account QuickBooks has and we do not', () => {
    const result = compareTrialBalance(ours([]), theirs, MAPPING)
    expect(result.ties).toBe(false)
    expect(result.lines).toHaveLength(3)
    expect(result.lines.every(l => l.ours === 0)).toBe(true)
  })

  it('reports an account we have and QuickBooks does not', () => {
    const result = compareTrialBalance(
      ours([{ code: '5000', name: 'Management fee', balance: 50_000 }]),
      [],
      MAPPING,
    )
    expect(result.lines.find(l => l.code === '5000')).toMatchObject({ ours: 50_000, theirs: 0 })
  })

  it('sums several QuickBooks accounts that map to one of ours', () => {
    const many = [
      { account: 'Bank:Operating', debit: 100_000, credit: 0 },
      { account: 'Bank:Savings', debit: 150_000, credit: 0 },
    ]
    const mapping = new Map([['Bank:Operating', '1000'], ['Bank:Savings', '1000']])
    const result = compareTrialBalance(ours([{ code: '1000', name: 'Cash', balance: 250_000 }]), many, mapping)
    expect(result.ties).toBe(true)
  })

  it('ignores unmapped QuickBooks accounts rather than reporting them as differences', () => {
    // An unmapped account is a MAPPING problem, surfaced on the mapping screen. Reporting it
    // here would bury the real differences under noise.
    const withExtra = [...theirs, { account: 'Suspense', debit: 999, credit: 0 }]
    const result = compareTrialBalance(
      ours([
        { code: '1000', name: 'Cash', balance: 250_000 },
        { code: '1100', name: 'Investments at cost', balance: 3_000_000 },
        { code: '3100', name: "Partners' capital", balance: -3_250_000 },
      ]),
      withExtra,
      MAPPING,
    )
    expect(result.ties).toBe(true)
  })

  it('ignores sub-cent rounding', () => {
    const result = compareTrialBalance(
      ours([
        { code: '1000', name: 'Cash', balance: 250_000.004 },
        { code: '1100', name: 'Investments at cost', balance: 3_000_000 },
        { code: '3100', name: "Partners' capital", balance: -3_250_000 },
      ]),
      theirs,
      MAPPING,
    )
    expect(result.ties).toBe(true)
  })
})


describe('real ledger normal-side balances', () => {
  it('ties credit-normal capital, retained earnings, and income to QuickBooks credits', () => {
    const accounts: Account[] = [
      { id: 'cash', fundId: 'f', code: '1000', name: 'Cash', type: 'asset' },
      { id: 'capital', fundId: 'f', code: '3100', name: 'Partners capital', type: 'equity' },
      { id: 'retained', fundId: 'f', code: '3900', name: 'Retained earnings', type: 'equity' },
      { id: 'interest', fundId: 'f', code: '4100', name: 'Interest income', type: 'income' },
      { id: 'other', fundId: 'f', code: '4900', name: 'Other income', type: 'income' },
      { id: 'prepaid', fundId: 'f', code: '3900.1', name: 'Prepaid capital call', type: 'equity' },
    ]
    const amounts = [120000, -30000, 8000, -52000, -40000, -6000]
    const ledger = trialBalance(accounts, accounts.map((a, i) => ({ accountId: a.id, amount: amounts[i], currency: 'USD' })))
    expect(ledger.rows.find(a => a.code === '4100')?.balance).toBe(52000)
    const qb = accounts.map((a, i) => ({ account: a.name, debit: Math.max(amounts[i], 0), credit: Math.max(-amounts[i], 0) }))
    const result = compareTrialBalance(ledger, qb, new Map(accounts.map(a => [a.name, a.code])))
    expect(result).toMatchObject({ ties: true, lines: [], ourTotal: 0, theirTotal: 0 })
  })

  it('still reports an extra opening cash/capital entry instead of hiding it', () => {
    const accounts: Account[] = [
      { id: 'cash', fundId: 'f', code: '1000', name: 'Cash', type: 'asset' },
      { id: 'lp', fundId: 'f', code: '3100-lp', name: 'Partner', type: 'equity' },
    ]
    const ledger = trialBalance(accounts, [{ accountId: 'cash', amount: 1250000, currency: 'USD' }, { accountId: 'lp', amount: -1250000, currency: 'USD' }])
    const result = compareTrialBalance(ledger, [], new Map())
    expect(result.lines.map(l => l.difference)).toEqual([1250000, -1250000])
  })
})

describe('per-LP capital detail', () => {
  it('reconciles dedicated LP accounts to pooled QuickBooks capital without hiding other differences', () => {
    const ledger = ours([
      { code: '3100', name: 'Unallocated capital', balance: -20 },
      { code: '3100-a', name: 'LP A', balance: -80 },
    ])
    const qb = [{ account: 'Partner investments', debit: 0, credit: 100 }]
    const mapping = new Map([['Partner investments', '3100']])
    const rollups = new Map([['3100-a', '3100']])
    expect(compareTrialBalance(ledger, qb, mapping, rollups).ties).toBe(true)
    expect(compareTrialBalance(ledger, [{ ...qb[0], credit: 90 }], mapping, rollups).lines[0].difference).toBe(-10)
  })
  it('keeps an explicitly mapped LP account separate', () => {
    const ledger = ours([{ code: '3100-a', name: 'LP A', balance: -80 }])
    const result = compareTrialBalance(ledger, [{ account: 'Capital:A', debit: 0, credit: 80 }],
      new Map([['Capital:A', '3100-a']]), new Map([['3100-a', '3100']]))
    expect(result.ties).toBe(true)
  })
})

describe('compareTrialBalance with tax-routed entries', () => {
  // A tax-basis QuickBooks file: the preparer booked a 50,000 K-1 loss from a lower-tier fund
  // against the investment and a K-1 income account. The import sent that entry to the tax book,
  // so the ledger holds the investment at 3,000,000 while QuickBooks says 2,950,000.
  const TAX_TB = parseQbTrialBalance([
    'Account,Debit,Credit',
    'Bank:Operating,"250,000.00",',
    'Investments:Acme Ventures III,"2,950,000.00",',
    'K-1 attributes,"50,000.00",',
    "Partners' Capital,,\"3,250,000.00\"",
  ].join('\n')).rows
  const mapping = new Map([...MAPPING, ['K-1 attributes', '4900']])
  const ledger = ours([
    { code: '1000', name: 'Cash', balance: 250_000 },
    { code: '1100', name: 'Investments at cost', balance: 3_000_000 },
    { code: '3100', name: "Partners' capital", balance: -3_250_000 },
  ])
  const taxBook = ours([
    { code: '1100', name: 'Investments at cost', balance: -50_000 },
    { code: '4900', name: 'K-1 income', balance: 50_000 },
  ])

  it('without them, the correctly routed entries are exactly the differences', () => {
    const result = compareTrialBalance(ledger, TAX_TB, mapping)
    expect(result.ties).toBe(false)
    expect(result.lines.map(l => [l.code, l.difference])).toEqual([['1100', 50_000], ['4900', -50_000]])
    expect(result.taxRouted).toEqual({ lines: [], total: 0 })
  })

  it('takes them out of the QuickBooks side, so the actual book ties, and reports them on their own', () => {
    const result = compareTrialBalance(ledger, TAX_TB, mapping, new Map(), taxBook)
    expect(result.ties).toBe(true)
    expect(result.taxRouted).toEqual({
      lines: [
        { code: '1100', name: 'Investments at cost', amount: -50_000 },
        { code: '4900', name: 'K-1 income', amount: 50_000 },
      ],
      total: 0,
    })
  })

  it('a tax-routed entry not yet imported still shows as a difference', () => {
    const partial = ours([{ code: '1100', name: 'Investments at cost', balance: -20_000 }, { code: '4900', name: 'K-1 income', balance: 20_000 }])
    const result = compareTrialBalance(ledger, TAX_TB, mapping, new Map(), partial)
    expect(result.lines.map(l => [l.code, l.difference])).toEqual([['1100', 30_000], ['4900', -30_000]])
  })

  it('rolls a tax-routed per-partner capital line up to the pooled account, as it does ours', () => {
    const capitalTax = ours([{ code: '3101', name: 'Capital — Jane Doe', balance: -1_000 }, { code: '4900', name: 'K-1 income', balance: 1_000 }])
    const result = compareTrialBalance(ledger, TAX_TB, mapping, new Map([['3101', '3100']]), capitalTax)
    expect(result.taxRouted.lines.map(l => l.code)).toEqual(['3100', '4900'])
  })
})
