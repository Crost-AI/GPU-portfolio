import { describe, expect, it } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { computeSummary } from '@/lib/investments'
import { fundTimeseries } from './fund-timeseries'

/**
 * New + follow-on must tie to invested capital at every quarter, so the per-row cost has to be the
 * same rule computeSummary sums — fee included. It once left the fee out: a $100,000 buy with a
 * $1,000 fee showed 101,000 invested and 100,000 of new + follow-on in the same series.
 */
describe('fundTimeseries new + follow-on ties to invested capital', () => {
  it('includes a capitalised acquisition fee', async () => {
    const investment_transactions = [
      { id: 't1', fund_id: 'f', company_id: 'k1', portfolio_group: 'Fund I', transaction_type: 'investment', transaction_date: '2025-02-01', investment_cost: 100_000, fee_amount: 1_000 },
      { id: 't2', fund_id: 'f', company_id: 'k1', portfolio_group: 'Fund I', transaction_type: 'investment', transaction_date: '2025-08-01', investment_cost: 40_000, fee_amount: 250 },
    ]
    const { admin } = memoryAdmin({
      fund_vehicles: [{ id: 'v1', fund_id: 'f', name: 'Fund I', aliases: [] }],
      companies: [{ id: 'k1', fund_id: 'f', name: 'Acme', status: 'active' }],
      investment_transactions,
    })

    const { points } = await fundTimeseries(admin as any, 'f', 'Fund I', '2025-12-31')
    const total = computeSummary(investment_transactions as any, 'active', new Date('2025-12-31')).totalInvested
    expect(total).toBe(141_250)
    const q1 = points.find(p => p.period === '2025-03-31')!
    expect(q1).toMatchObject({ newInvested: 101_000, followOnInvested: 0, investedCapital: 101_000 })
    const last = points.at(-1)!
    expect(last).toMatchObject({ newInvested: 101_000, followOnInvested: 40_250, investedCapital: total })
    for (const p of points) expect(p.newInvested + p.followOnInvested).toBe(p.investedCapital)
  })
})
