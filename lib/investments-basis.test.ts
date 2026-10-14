import { describe, expect, it } from 'vitest'
import { computeSummary, investedBasis } from './investments'

/**
 * One definition of invested capital. The timeseries once summed cost without the fee, so a
 * $100,000 buy with a $1,000 fee showed 101,000 invested while new + follow-on summed to 100,000.
 */
const row = (over: Record<string, unknown>) => ({ investment_cost: null, interest_converted: null, ...over }) as any

describe('investedBasis', () => {
  it('is the cash cost of a plain buy', () => {
    expect(investedBasis(row({ investment_cost: 100_000 }))).toBe(100_000)
  })

  it('capitalises the acquisition fee', () => {
    expect(investedBasis(row({ investment_cost: 100_000, fee_amount: 1_000 }))).toBe(101_000)
  })

  it('adds converted interest on a conversion row only', () => {
    expect(investedBasis(row({ investment_cost: 0, interest_converted: 2_500, converts_from_txn_id: 'safe' }))).toBe(2_500)
    expect(investedBasis(row({ investment_cost: 50_000, interest_converted: 2_500 }))).toBe(50_000)
  })

  it('treats missing figures as zero', () => {
    expect(investedBasis(row({}))).toBe(0)
  })

  it('sums to computeSummary.totalInvested', () => {
    const txns = [
      { id: 's', transaction_type: 'investment', round_name: 'SAFE', transaction_date: '2024-01-01', investment_cost: 50_000 },
      { id: 'a', transaction_type: 'investment', round_name: 'Series A', transaction_date: '2025-01-01', investment_cost: 100_000, fee_amount: 1_000, shares_acquired: 1000, share_price: 100 },
      { id: 'c', transaction_type: 'investment', round_name: 'Series A', transaction_date: '2025-01-01', investment_cost: 0, interest_converted: 2_500, converts_from_txn_id: 's', shares_acquired: 525, share_price: 100 },
    ] as any[]
    const sum = txns.reduce((s, t) => s + investedBasis(t), 0)
    expect(sum).toBe(153_500)
    expect(computeSummary(txns, 'active', new Date('2026-01-01')).totalInvested).toBe(sum)
  })
})
