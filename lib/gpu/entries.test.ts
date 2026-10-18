import { describe, it, expect } from 'vitest'
import { buildCapexEntry, buildDepreciationEntry, buildDisposalEntry, buildPurchaseEntry, gpuSourceRef } from './entries'
import { depreciationSchedule } from './depreciation'
import { assetBalances } from './disposal'
import { contingencyPosition, unspentContingency } from './contingency'
import type { JournalEntry } from '@/lib/accounting/types'

const ACC = { cash: 'acc-1000', ap: 'acc-2000', cost: 'acc-1600-a', accum: 'acc-1650-a', dep: 'acc-5300', gain: 'acc-4500' }
const CHART = [
  { id: ACC.cost, code: '1600-aaaaaaaa' },
  { id: ACC.accum, code: '1650-aaaaaaaa' },
]
const ASSET = 'aaaaaaaa-0000-4000-8000-000000000000'
const base = { fundId: 'f', entryDate: '2027-01-10' }
const legs = (e: JournalEntry) => Object.fromEntries(e.postings.map(p => [p.accountId, p.amount]))

describe('lifecycle entries (§2.6)', () => {
  it('purchase: Dr 1600-<a> / Cr cash or payables, with a deterministic ref', () => {
    const e = buildPurchaseEntry(base, { assetId: ASSET, amount: 335_000, costAccountId: ACC.cost, offsetAccountId: ACC.ap })
    expect(legs(e)).toEqual({ [ACC.cost]: 335_000, [ACC.ap]: -335_000 })
    expect([e.sourceType, e.sourceRef]).toEqual(['manual', `gpu-asset:${ASSET}:purchase`])
  })

  it('capex: its ref carries the caller\'s idempotency key', () => {
    const e = buildCapexEntry(base, { assetId: ASSET, key: 'inv-4471', amount: 1_250, costAccountId: ACC.cost, offsetAccountId: ACC.cash })
    expect(e.sourceRef).toBe(`gpu-asset:${ASSET}:capex:inv-4471`)
    expect(legs(e)).toEqual({ [ACC.cost]: 1_250, [ACC.cash]: -1_250 })
  })

  it('depreciation: Dr 5300 / Cr 1650-<a>, dated at month end, partnership_expense', () => {
    const e = buildDepreciationEntry({ fundId: 'f', assetId: ASSET, month: '2028-02', amount: 5_025, expenseAccountId: ACC.dep, accumulatedAccountId: ACC.accum })
    expect([e.entryDate, e.sourceType, e.sourceRef]).toEqual(['2028-02-29', 'partnership_expense', gpuSourceRef.depreciation(ASSET, '2028-02')])
    expect(legs(e)).toEqual({ [ACC.dep]: 5_025, [ACC.accum]: -5_025 })
  })
})

describe('disposal', () => {
  const dispose = (proceeds: number, cost: number, accumulated: number) => buildDisposalEntry(
    { fundId: 'f', entryDate: '2031-12-31' },
    { assetId: ASSET, proceeds, cost, accumulated, cashAccountId: ACC.cash, costAccountId: ACC.cost, accumulatedAccountId: ACC.accum, gainAccountId: ACC.gain },
  )

  it('at book after 60 months books $0 gain and clears 1600-<a> and 1650-<a> from the ledger', () => {
    // The ledger the disposal reads: the purchase plus every month the close posted.
    const ledger: JournalEntry[] = [
      buildPurchaseEntry(base, { assetId: ASSET, amount: 335_000, costAccountId: ACC.cost, offsetAccountId: ACC.cash }),
      ...depreciationSchedule({ id: ASSET, basis: 335_000, salvage: 33_500, lifeMonths: 60, inServiceDate: '2027-01-15', convention: 'full_month' })
        .map(l => buildDepreciationEntry({ fundId: 'f', assetId: ASSET, month: l.month, amount: l.amount, expenseAccountId: ACC.dep, accumulatedAccountId: ACC.accum })),
    ]
    const before = assetBalances(CHART, ledger.flatMap(e => e.postings), ASSET)
    expect(before).toEqual({ cost: 335_000, accumulated: 301_500 })

    const { entry, gain } = dispose(33_500, before.cost, before.accumulated)
    expect(gain).toBe(0)
    expect(entry.postings.some(p => p.accountId === ACC.gain)).toBe(false)
    expect([entry.sourceType, entry.sourceRef]).toEqual(['realized_gain', `gpu-asset:${ASSET}:disposal`])
    expect(assetBalances(CHART, [...ledger, entry].flatMap(e => e.postings), ASSET)).toEqual({ cost: 0, accumulated: 0 })
  })

  it('a gain credits 4500 and a loss debits it', () => {
    expect(legs(dispose(40_000, 335_000, 301_500).entry)[ACC.gain]).toBe(-6_500)
    const loss = dispose(10_000, 335_000, 301_500)
    expect(loss.gain).toBe(-23_500)
    expect(legs(loss.entry)[ACC.gain]).toBe(23_500)
  })
})

describe('contingency (R8)', () => {
  // The pack raises 1.10 × hardware: a 130,500 contingency on 1,305,000 of servers.
  const assets = [{ capitalized_costs: 12_000 }, { capitalized_costs: 8_750.25 }, { capitalized_costs: null }]

  it('unspent = budget − Σ capitalized_costs, never negative', () => {
    expect(unspentContingency(130_500, assets)).toBe(109_749.75)
    expect(unspentContingency(20_000, assets)).toBe(0)
    expect(unspentContingency(130_500, [])).toBe(130_500)
  })

  it('reports an overrun instead of a negative return', () => {
    expect(contingencyPosition(20_000, assets)).toEqual({ budget: 20_000, spent: 20_750.25, unspent: 0, overrun: 750.25 })
  })
})
