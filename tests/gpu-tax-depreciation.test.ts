import { describe, it, expect } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { A, B, GROUP, gpuTaxYear } from '@/tests/helpers/gpu-tax-year'
import { loadFleetTaxYear } from '@/lib/gpu/tax-adjustments'
import { proposeFleetAdjustments } from '@/lib/accounting/book-tax'
import { buildFleetDifferenceEntry, buildTaxAdjustmentEntries } from '@/lib/accounting/book-tax-entries'
import { postTaxAdjustments } from '@/lib/accounting/book-tax-run'

/**
 * ── GPU fleet (P1c) ── The book-to-tax run's per-server depreciation difference (#68): tax
 * depreciation less the book depreciation posted in the year, and for a server disposed of in the
 * year the cumulative difference moved into the gain. Each entry allocates to partners the way the
 * close allocated the P&L it adjusts, so tax capital moves with the K-1 lines.
 */

const acc = (id: string) => `1650-${id.slice(0, 8)}`

describe('the fleet tax year', () => {
  it('per server: MACRS against the depreciation posted, and the disposal at tax basis', async () => {
    const fleet = await loadFleetTaxYear(memoryAdmin(gpuTaxYear()).admin as any, 'f', 'v-gpu', 2027)
    expect(fleet.depreciation).toEqual([
      { assetId: A, name: 'H200 #1', accumulatedAccountId: acc(A), book: 18_000, tax: 20_000, difference: 2_000 },
      { assetId: B, name: 'H200 #2', accumulatedAccountId: acc(B), book: 13_500, tax: 0, difference: -13_500 },
    ])
    expect(fleet.disposals).toEqual([
      { assetId: B, name: 'H200 #2', accumulatedAccountId: acc(B), book: 13_500, tax: 0, difference: -13_500 },
    ])
  })

  it('a server on the book tax method, or not purchased, has no difference', async () => {
    const t = gpuTaxYear()
    t.gpu_assets[0].tax_method = 'book'
    t.journal_entries = t.journal_entries.filter(e => e.source_ref !== `gpu-asset:${B}:purchase`)
    const fleet = await loadFleetTaxYear(memoryAdmin(t).admin as any, 'f', 'v-gpu', 2027)
    expect(fleet).toEqual({ depreciation: [], disposals: [], unposted: [], laterDisposals: [] })
  })

  it('the next year: only the held server, and nothing for the one sold', async () => {
    const fleet = await loadFleetTaxYear(memoryAdmin(gpuTaxYear()).admin as any, 'f', 'v-gpu', 2028)
    // MACRS year 2 is 32,000; the books posted nothing in 2028 in this fixture.
    expect(fleet.depreciation.map(l => [l.assetId, l.book, l.tax])).toEqual([[A, 0, 32_000]])
    expect(fleet.disposals).toEqual([])
  })
})

describe('the fleet tax year measures book depreciation by journal date', () => {
  it('a December charge posted in January counts in January\'s year; the schedule month does not move it', async () => {
    const admin = memoryAdmin(gpuTaxYear({ catchUpDecember: true, year2028: {} })).admin as any
    const y2027 = await loadFleetTaxYear(admin, 'f', 'v-gpu', 2027)
    const y2028 = await loadFleetTaxYear(admin, 'f', 'v-gpu', 2028)
    expect(y2027.depreciation.find(l => l.assetId === A)).toMatchObject({ book: 16_500, tax: 20_000, difference: 3_500 })
    expect(y2028.depreciation.find(l => l.assetId === A)).toMatchObject({ book: 19_500, tax: 32_000, difference: 12_500 })
  })
})

describe('the proposals and their entries', () => {
  const fleet = {
    depreciation: [
      { assetId: A, name: 'H200 #1', accumulatedAccountId: acc(A), book: 18_000, tax: 20_000, difference: 2_000 },
      { assetId: B, name: 'H200 #2', accumulatedAccountId: acc(B), book: 13_500, tax: 0, difference: -13_500 },
    ],
    disposals: [{ assetId: B, name: 'H200 #2', accumulatedAccountId: acc(B), book: 13_500, tax: 0, difference: -13_500 }],
  }
  const accts = {
    depreciationExpenseId: 'g-5300', disposalGainId: 'g-4500', bridgeId: 'g-3200',
    capMap: new Map([['lp-a', 'cap-a'], ['lp-b', 'cap-b']]),
    weights: { depreciation: new Map([['lp-a', 23_400], ['lp-b', 15_600]]), disposal_basis: new Map([['lp-a', -2_100], ['lp-b', -1_400]]) },
  }

  it('book income over tax income: depreciation -11,500, disposal basis +13,500, each with its servers', () => {
    const proposals = proposeFleetAdjustments(fleet)
    expect(proposals.map(p => [p.kind, p.amount, p.permanent, p.assets?.length])).toEqual([['depreciation', -11_500, false, 2], ['disposal_basis', 13_500, false, 1]])
    expect(proposeFleetAdjustments({ depreciation: [], disposals: [] })).toEqual([])
  })

  it('depreciation: the P&L against each server\'s 1650, and the same into capital by the expense weights', () => {
    const e = buildFleetDifferenceEntry({ fundId: 'f', entryDate: '2027-12-31' }, 'depreciation', fleet.depreciation, accts)
    expect(e.sourceType).toBe('tax_adj_depreciation')
    expect(e.postings.map(p => [p.accountId, p.amount, p.lpEntityId])).toEqual([
      [acc(A), -2_000, null], [acc(B), 13_500, null], ['g-5300', -11_500, null],
      ['cap-a', -6_900, 'lp-a'], ['cap-b', -4_600, 'lp-b'], ['g-3200', 11_500, null],
    ])
  })

  it('disposal basis: clears the sold server\'s 1650 into the gain, and the partners bear it by the gain weights', () => {
    const e = buildFleetDifferenceEntry({ fundId: 'f', entryDate: '2027-12-31' }, 'disposal_basis', fleet.disposals, accts)
    expect(e.sourceType).toBe('tax_adj_disposal')
    expect(e.postings.map(p => [p.accountId, p.amount, p.lpEntityId])).toEqual([
      [acc(B), -13_500, null], ['g-4500', 13_500, null],
      ['cap-a', 8_100, 'lp-a'], ['cap-b', 5_400, 'lp-b'], ['g-3200', -13_500, null],
    ])
  })

  it('servers that offset: one proposal of nil carrying both, and an entry of their 1650 lines alone', () => {
    const offset = [
      { assetId: A, name: 'H200 #1', accumulatedAccountId: acc(A), book: 18_000, tax: 20_000, difference: 2_000 },
      { assetId: B, name: 'H200 #2', accumulatedAccountId: acc(B), book: 22_000, tax: 20_000, difference: -2_000 },
    ]
    const proposals = proposeFleetAdjustments({ depreciation: offset, disposals: offset })
    expect(proposals.map(p => [p.kind, p.amount, p.assets?.length])).toEqual([['depreciation', 0, 2], ['disposal_basis', 0, 2]])
    // No partner weights at all: nothing reaches the P&L, so nothing is refused for want of them.
    const { entries, skipped } = buildTaxAdjustmentEntries({
      base: { fundId: 'f', entryDate: '2027-12-31' }, proposals, accounts: {} as any,
      fleet: { ...accts, weights: {} },
    })
    expect(skipped).toEqual([])
    expect(entries.map(e => [e.sourceType, e.postings.map(p => [p.accountId, p.amount])])).toEqual([
      ['tax_adj_depreciation', [[acc(A), -2_000], [acc(B), 2_000]]],
      ['tax_adj_disposal', [[acc(A), 2_000], [acc(B), -2_000]]],
    ])
  })

  it('refuses rather than posting a difference nobody can be allocated', () => {
    const { entries, skipped } = buildTaxAdjustmentEntries({
      base: { fundId: 'f', entryDate: '2027-12-31' }, proposals: proposeFleetAdjustments(fleet), accounts: {} as any,
      fleet: { ...accts, weights: { depreciation: new Map(), disposal_basis: new Map([['lp-a', 0]]) } },
    })
    expect(entries).toEqual([])
    expect(skipped.map(s => s.kind)).toEqual(['depreciation', 'disposal_basis'])
  })
})

describe('the run on a GPU SPV', () => {
  it('proposes the depreciation and disposal-basis differences and nothing for 5200 or 5250', async () => {
    const r = await postTaxAdjustments(memoryAdmin(gpuTaxYear()).admin as any, 'f', GROUP, 'u', 2027, { preview: true })
    if ('error' in r) throw new Error(r.error)
    expect(r.proposals.map(p => [p.kind, p.amount])).toEqual([['depreciation', -11_500], ['disposal_basis', 13_500]])
    expect(r.missingAccounts).toEqual([])
    expect(r.skipped).toEqual([])
  })

  it('names the account it is missing rather than posting part of the set', async () => {
    const t = gpuTaxYear()
    t.chart_of_accounts = t.chart_of_accounts.filter(a => a.code !== '5300')
    const r = await postTaxAdjustments(memoryAdmin(t).admin as any, 'f', GROUP, 'u', 2027)
    if ('error' in r) throw new Error(r.error)
    expect(r.missingAccounts).toEqual(['depreciation expense'])
    expect(r.entryIds).toEqual([])
  })
})
