import { describe, expect, it } from 'vitest'
import { DEFAULT_CHART, GPU_SPV_CHART, assetAccountCode } from './chart'
import { computePayload, type LedgerData } from './statement-package'
import type { Account } from './types'
import type { SourcedPosting } from './load'

/**
 * A GPU SPV's statements (gpu-P4 B2, pivot plan §5.4): the cash-flow statement reports its
 * equipment as investing, and every other kind's statement package is byte-identical to before
 * (the `fof` precedent: an optional block, absent unless it applies).
 */

const A1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const A2 = 'bbbbbbbb-0000-0000-0000-000000000002'

function chart(seeds: { code: string; name: string; type: string; subtype?: string | null }[], extra: { code: string; name: string; type: string; subtype: string }[] = []): Account[] {
  return [...seeds, ...extra].map(a => ({ id: `acct-${a.code}`, fundId: 'f1', code: a.code, name: a.name, type: a.type as Account['type'], subtype: a.subtype ?? null, lpEntityId: null, companyId: null }))
}
const id = (code: string) => `acct-${code}`

/** Entries as [entryId, date, sourceType, [code, amount][]] → the posting arrays LedgerData holds. */
function ledger(accounts: Account[], kind: string, entries: [string, string, string, [string, number][]][]): LedgerData {
  const sourced: SourcedPosting[] = entries.flatMap(([entryId, date, sourceType, legs]) =>
    legs.map(([code, amount]) => ({ entryId, entryDate: date, sourceType, memo: entryId, accountId: id(code), amount, currency: 'USD', lpEntityId: code.startsWith('3100') ? 'lp1' : null })))
  return {
    accounts, postings: sourced, sourcedPostings: sourced,
    capitalPostings: sourced.filter(p => p.lpEntityId).map(p => ({ entryId: p.entryId, lpEntityId: p.lpEntityId!, amount: p.amount, sourceType: p.sourceType, entryDate: p.entryDate })),
    names: new Map([['lp1', 'Investor One']]), txns: [], companies: [], group: 'V', fofRaw: null, feeds: [], observations: [],
    cashAccount: accounts.find(a => a.code === '1000'), gpAccount: accounts.find(a => a.code === '3000'),
    earliest: entries[0]?.[1] ?? null, kind,
  }
}
const YEAR = { start: '2027-01-01', end: '2027-12-31', label: '2027' } as any

export const VC_ENTRIES: [string, string, string, [string, number][]][] = [
  ['call', '2027-01-15', 'capital_call', [['1000', 1_000_000], ['3100', -1_000_000]]],
  ['invest', '2027-02-01', 'manual', [['1100', 800_000], ['1000', -800_000]]],
  ['fee', '2027-03-31', 'management_fee', [['5000', 20_000], ['1000', -20_000]]],
  ['exit', '2027-11-30', 'manual', [['1000', 900_000], ['1100', -800_000], ['4000', -100_000]]],
]

describe('every kind other than a GPU SPV: the statement package is unchanged', () => {
  it('a fund: the whole payload, pinned (taken before the GPU change)', () => {
    const p = computePayload(ledger(chart(DEFAULT_CHART), 'fund', VC_ENTRIES), YEAR)
    expect('investing' in p.cashFlows!).toBe(false)
    expect(JSON.stringify(p)).toMatchSnapshot()
  })
})

const GPU_ACCOUNTS = chart(GPU_SPV_CHART, [
  { code: assetAccountCode('1600', A1), name: 'GPU equipment at cost — srv-1', type: 'asset', subtype: 'fixed_asset' },
  { code: assetAccountCode('1650', A1), name: 'Accumulated depreciation — srv-1', type: 'asset', subtype: 'accumulated_depreciation' },
  { code: assetAccountCode('1600', A2), name: 'GPU equipment at cost — srv-2', type: 'asset', subtype: 'fixed_asset' },
  { code: assetAccountCode('1650', A2), name: 'Accumulated depreciation — srv-2', type: 'asset', subtype: 'accumulated_depreciation' },
])
const C1 = assetAccountCode('1600', A1), D1 = assetAccountCode('1650', A1)
const C2 = assetAccountCode('1600', A2), D2 = assetAccountCode('1650', A2)

export const GPU_ENTRIES: [string, string, string, [string, number][]][] = [
  ['call', '2027-01-05', 'capital_call', [['1000', 1_000_000], ['3100', -1_000_000]]],
  ['buy-1', '2027-01-10', 'manual', [[C1, 410_000], ['1000', -410_000]]],
  ['capex-1', '2027-01-20', 'manual', [[C1, 12_000], ['1000', -12_000]]],
  // Bought on credit: no cash, a non-cash investing transaction.
  ['buy-2', '2027-02-01', 'manual', [[C2, 335_000], ['2000', -335_000]]],
  ['rent', '2027-02-28', 'manual', [['1150', 30_000], ['4000', -30_000]]],
  ['payout', '2027-03-15', 'manual', [['1000', 30_000], ['1150', -30_000]]],
  ['dc', '2027-03-31', 'manual', [['5100', 10_000], ['1000', -10_000]]],
  ['dep-1', '2027-03-31', 'partnership_expense', [['5300', 6_000], [D1, -6_000]]],
  ['dep-2', '2027-03-31', 'partnership_expense', [['5300', 5_000], [D2, -5_000]]],
  // srv-1 sold for 50,000: cost 422,000 and 6,000 depreciated cleared, a 366,000 loss.
  ['sale-1', '2027-11-30', 'manual', [['1000', 50_000], [D1, 6_000], [C1, -422_000], ['4500', 366_000]]],
]

describe("a GPU SPV's cash-flow statement: equipment is investing", () => {
  const p = computePayload(ledger(GPU_ACCOUNTS, 'gpu_spv', GPU_ENTRIES), YEAR)
  const cf = p.cashFlows!

  it('purchases, capitalized costs and the sale are investing; depreciation never appears', () => {
    expect(cf.investing).toEqual({
      label: 'Investing activities',
      lines: [
        { code: '1600', name: 'Purchases of equipment and capitalized costs', amount: -422_000 },
        { code: '1600', name: 'Proceeds from disposal of equipment', amount: 50_000 },
      ],
      total: -372_000,
    })
    expect(cf.operating.lines.map(l => l.code)).toEqual(['1150', '5100'])
    expect(cf.operating.total).toBe(20_000)
    expect(cf.financing.total).toBe(1_000_000)
    expect([...cf.operating.lines, ...cf.investing!.lines, ...cf.financing.lines].some(l => /5300|1650|Depreciation/.test(`${l.code} ${l.name}`))).toBe(false)
  })

  it('net change is operating + investing + financing, and ties to the cash on the balance sheet', () => {
    expect(cf.netChange).toBe(20_000 - 372_000 + 1_000_000)
    expect(cf.endingCash).toBe(648_000)
    expect(GPU_ENTRIES.flatMap(e => e[3]).filter(([code]) => code === '1000').reduce((s, [, a]) => s + a, 0)).toBe(648_000)
  })

  it('equipment bought on credit is disclosed as a non-cash investing transaction; depreciation is not', () => {
    expect(cf.nonCash.map(n => n.entryId)).toEqual(['buy-2'])
  })
})
