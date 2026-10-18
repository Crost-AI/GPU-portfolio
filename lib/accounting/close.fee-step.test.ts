import { describe, it, expect, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

// The close's gross-revenue fee step: a fee accrual that cannot read its basis fails the close,
// which unwinds and drops the period rather than locking it half-done (or crashing).

const fee = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('@/lib/gpu/fee', () => ({
  loadFeeTerms: async () => ({ basis: 'gross_revenue', annualRate: 0.05, revenueSubtypes: ['rental_revenue'], frequency: 'monthly', payeeVehicleId: null }),
  accrueGrossRevenueFee: async (_a: unknown, _f: string, _g: string, _u: unknown, month: string) => {
    fee.calls.push(month)
    return { error: 'The fee basis could not be read: journal_postings read failed: statement timeout' }
  },
}))

import { closePeriodWithAllocation } from './close'

const accounts = [
  { id: 'cash', code: '1000', name: 'Cash', type: 'asset', subtype: 'cash' },
  { id: 'capA', code: '3100-a', name: 'Capital — A', type: 'equity', subtype: 'lp_capital', lp_entity_id: 'a' },
  { id: 'bridge', code: '3200', name: 'Undistributed earnings', type: 'equity', subtype: 'undistributed_earnings' },
  { id: 'rev', code: '4000', name: 'GPU rental revenue', type: 'income', subtype: 'rental_revenue' },
  { id: 'fee', code: '5000', name: 'Management fee', type: 'expense', subtype: 'management_fee' },
]

describe('closePeriodWithAllocation: the fee step', () => {
  it('a failed fee accrual fails the close and removes the period it opened', async () => {
    const m = memoryAdmin({
      fund_vehicles: [{ id: 'v1', fund_id: 'f', name: 'GPU I', kind: 'gpu_spv' }],
      fund_settings: [{ fund_id: 'f', currency: 'USD' }],
      chart_of_accounts: accounts.map(a => ({ ...a, fund_id: 'f', vehicle_id: 'v1', lp_entity_id: (a as any).lp_entity_id ?? null })),
      lp_investments: [{ id: 'i1', fund_id: 'f', portfolio_group: 'GPU I', entity_id: 'a', commitment: 1_000_000 }],
      fiscal_periods: [],
    })
    const out = await closePeriodWithAllocation(m.admin, 'f', 'GPU I', null, '2027-01-01', '2027-02-28')
    expect(out).toEqual({ error: expect.stringMatching(/^Management fee accrual failed \(January 2027\): The fee basis could not be read/) })
    expect(fee.calls).toEqual(['2027-01'])
    expect(m.tables.fiscal_periods).toEqual([])
  })
})
