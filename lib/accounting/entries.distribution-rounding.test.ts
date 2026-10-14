import { describe, it, expect } from 'vitest'
import { buildDistributionEntry, type CapitalAccountMap } from './entries'
import { isBalanced } from './ledger'

const base = { fundId: 'f', entryDate: '2026-06-30' }
const capMap: CapitalAccountMap = new Map([['a', 'cap-a'], ['b', 'cap-b'], ['c', 'cap-c']])

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
