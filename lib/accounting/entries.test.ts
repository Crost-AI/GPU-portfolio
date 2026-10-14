import { describe, it, expect } from 'vitest'
import {
  buildDistributionEntry, buildCarryEntry, buildAssociateMarkupEntry, buildPeriodCloseEntry,
  buildExpenseEntry, buildDistributionDeclarationEntry, buildCapitalCallIssuanceEntry, type CapitalAccountMap,
} from './entries'
import { isBalanced } from './ledger'

const base = { fundId: 'f', entryDate: '2026-06-30' }
const capMap: CapitalAccountMap = new Map([['a', 'cap-a'], ['b', 'cap-b'], ['c', 'cap-c'], ['gp', 'cap-gp']])

describe('buildDistributionEntry rounding', () => {
  // Each partner's leg is rounded once; cash is the exact negation of the rounded legs' sum —
  // not of the unrounded amounts, which can land a cent away from what the legs add up to.
  const amounts = (e: ReturnType<typeof buildDistributionEntry>) => e.postings.map(p => [p.accountId, p.amount])

  it('cash is the sum of the rounded legs when rounding the running total would drift a cent', () => {
    // Legs 314,452.56 + 4.17 + 61.53 = 314,518.26. Rounding the running total of the unrounded
    // amounts instead gave 314,518.25, and the entry refused to balance.
    const e = buildDistributionEntry(base, new Map([['a', 314_452.559], ['b', 4.165], ['c', 61.53]]), capMap, 'cash')
    expect(amounts(e)).toEqual([['cap-a', 314_452.56], ['cap-b', 4.17], ['cap-c', 61.53], ['cash', -314_518.26]])
    expect(isBalanced(e)).toBe(true)
  })

  it('sub-cent shares: cash matches the rounded legs, not the 0.008 they came from', () => {
    const e = buildDistributionEntry(base, new Map([['a', 0.004], ['b', 0.004]]), capMap, 'cash')
    expect(amounts(e)).toEqual([['cap-a', 0], ['cap-b', 0], ['cash', 0]])
    expect(isBalanced(e)).toBe(true)
  })

  it('a half-cent amount rounds the same on the capital and the cash leg', () => {
    const e = buildDistributionEntry(base, new Map([['a', 1234.125]]), capMap, 'cash')
    expect(amounts(e)).toEqual([['cap-a', 1234.13], ['cash', -1234.13]])
    expect(isBalanced(e)).toBe(true)
  })

  it('several half-cent shares: cash is the sum of the rounded legs', () => {
    const e = buildDistributionEntry(base, new Map([['a', 1234.125], ['b', 0.005]]), capMap, 'cash')
    expect(amounts(e)).toEqual([['cap-a', 1234.13], ['cap-b', 0.01], ['cash', -1234.14]])
    expect(isBalanced(e)).toBe(true)
  })
})

describe('every offset leg is the exact negation of the rounded primary legs', () => {
  // Three shares whose unrounded running total rounds a cent away from the sum of the rounded
  // shares: 314,452.56 + 4.17 + 61.53 = 314,518.26, but the raw total rounds to 314,518.25.
  const drifting = new Map([['a', 314_452.559], ['b', 4.165], ['c', 61.53]])
  const amounts = (e: { postings: { accountId: string; amount: number }[] }) => e.postings.map(p => [p.accountId, p.amount])

  it('carry: the recipients are credited what the LP debits add up to', () => {
    const e = buildCarryEntry(base, drifting, capMap, 'gp-3000', 'USD', [{ lpEntityId: 'gp', pct: 100 }])
    expect(amounts(e)).toEqual([['cap-a', 314_452.56], ['cap-b', 4.17], ['cap-c', 61.53], ['cap-gp', -314_518.26]])
    const pooled = buildCarryEntry(base, drifting, capMap, 'gp-3000')
    expect(amounts(pooled).at(-1)).toEqual(['gp-3000', -314_518.26])
  })

  it('associate markup: Investment in Fund is debited what the member credits add up to', () => {
    const e = buildAssociateMarkupEntry(base, drifting, capMap, 'inv-1500', 'valuation')
    expect(amounts(e)).toEqual([['cap-a', -314_452.56], ['cap-b', -4.17], ['cap-c', -61.53], ['inv-1500', 314_518.26]])
  })

  it('period close: the bridge takes what the flattened P&L lines add up to', () => {
    const e = buildPeriodCloseEntry(base, Array.from(drifting, ([accountId, balance]) => ({ accountId, balance })), 'bridge')
    expect(amounts(e)).toEqual([['a', -314_452.56], ['b', -4.17], ['c', -61.53], ['bridge', 314_518.26]])
  })

  it('per-partner pairs mirror the rounded leg, half cents included', () => {
    const declared = buildDistributionDeclarationEntry(base, new Map([['a', 1234.125]]), capMap, 'payable')
    expect(amounts(declared)).toEqual([['cap-a', 1234.13], ['payable', -1234.13]])
    const called = buildCapitalCallIssuanceEntry(base, new Map([['a', 1234.125]]), capMap, 'receivable')
    expect(amounts(called)).toEqual([['receivable', 1234.13], ['cap-a', -1234.13]])
  })

  it('a sub-cent amount posts zeros, never -0', () => {
    const e = buildExpenseEntry(base, 0.004, { pnlAccountId: 'exp', offsetAccountId: 'cash' })
    for (const p of e.postings) expect(Object.is(p.amount, 0)).toBe(true)
  })
})
