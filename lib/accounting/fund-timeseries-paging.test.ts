import { describe, expect, it } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { fundTimeseries } from './fund-timeseries'

/**
 * The gross series reads the fund's whole investment tracker. Past PostgREST's max_rows (1000,
 * supabase/config.toml) an unpaged read dropped transactions — and with them invested capital —
 * from every quarter without an error. The client here enforces that cap.
 */
describe('fundTimeseries reads investment transactions past the 1000-row cap', () => {
  it('counts every investment in invested capital and in new + follow-on', async () => {
    const day = (i: number) => new Date(Date.UTC(2023, 0, 1) + i * 86_400_000).toISOString().slice(0, 10)
    const { admin } = memoryAdmin({
      fund_vehicles: [{ id: 'v1', fund_id: 'f', name: 'Fund I', aliases: [] }],
      companies: [{ id: 'k1', fund_id: 'f', name: 'Acme', status: 'active' }],
      investment_transactions: Array.from({ length: 1200 }, (_, i) => ({
        id: `t${String(i).padStart(5, '0')}`, fund_id: 'f', company_id: 'k1', portfolio_group: 'Fund I',
        transaction_type: 'investment', transaction_date: day(i), investment_cost: 100,
      })),
    }, { maxRows: 1000 })

    const series = await fundTimeseries(admin as any, 'f', 'Fund I', '2026-06-30')
    const last = series.points.at(-1)!
    expect(series.hasGross).toBe(true)
    expect(last.investedCapital).toBe(120_000)
    expect(last.newInvested + last.followOnInvested).toBe(120_000)
  })
})
