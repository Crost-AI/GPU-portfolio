import { describe, expect, it } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { aggregatePortfolioData } from './aggregate'

// A letter for a past quarter shows that quarter: transactions and cash flows after its last day
// are not counted, and an exit or first investment after it hadn't happened yet.
describe('letter figures as of the quarter end', () => {
  const store = memoryAdmin()
  const co = (id: string, name: string, status: string) => ({
    id, fund_id: 'f', name, status, stage: 'Seed', industry: null, overview: null, why_invested: null, current_update: null,
    holding_type: 'company', portfolio_group: ['Fund I'],
  })
  const txn = (company_id: string, transaction_type: string, transaction_date: string, extra: Record<string, unknown>) => ({
    fund_id: 'f', company_id, transaction_type, transaction_date, portfolio_group: 'Fund I', round_name: 'Seed',
    investment_cost: null, share_price: null, proceeds_received: null, proceeds_escrow: null, cost_basis_exited: null,
    current_share_price: null, shares_acquired: null, unrealized_value_change: null, converts_from_txn_id: null, ...extra,
  })
  store.tables.funds = [{ id: 'f', name: 'Hemlock' }]
  store.tables.fund_settings = [{ fund_id: 'f', currency: 'USD' }]
  store.tables.fund_vehicles = [{ id: 'v1', fund_id: 'f', name: 'Fund I', aliases: null }]
  store.tables.companies = [co('a', 'Acme', 'active'), co('b', 'Birch', 'exited'), co('c', 'Cedar', 'active')]
  store.tables.investment_transactions = [
    txn('a', 'investment', '2025-01-10', { investment_cost: 100, share_price: 1, shares_acquired: 100 }),
    txn('a', 'unrealized_gain_change', '2026-11-01', { current_share_price: 5 }),
    txn('b', 'investment', '2025-02-01', { investment_cost: 50, share_price: 1, shares_acquired: 50 }),
    txn('b', 'proceeds', '2026-11-15', { proceeds_received: 200, cost_basis_exited: 50 }),
    txn('c', 'investment', '2026-10-20', { investment_cost: 75, share_price: 1, shares_acquired: 75 }),
  ]
  store.tables.fund_cash_flows = [
    { fund_id: 'f', portfolio_group: 'Fund I', flow_type: 'called_capital', flow_date: '2025-01-01', amount: 150 },
    { fund_id: 'f', portfolio_group: 'Fund I', flow_type: 'distribution', flow_date: '2026-11-20', amount: 200 },
  ]
  for (const t of ['fund_group_config', 'metrics', 'metric_values', 'company_notes', 'company_summaries']) store.tables[t] = []

  it('counts nothing after Q3 2026 ended', async () => {
    const p = await aggregatePortfolioData(store.admin as any, 'f', 2026, 3, 'Fund I', false)
    expect(p.asOf).toBe('2026-09-30')
    const byName = Object.fromEntries(p.companies.map(c => [c.investment.companyName, c.investment]))
    expect(Object.keys(byName).sort()).toEqual(['Acme', 'Birch'])
    expect(byName.Acme.fmv).toBe(100)
    expect(byName.Birch).toMatchObject({ status: 'active', totalRealized: 0, fmv: 50 })
    expect(p.fundMetrics).toMatchObject({ paidInCapital: 150, distributions: 0 })
  })
})
