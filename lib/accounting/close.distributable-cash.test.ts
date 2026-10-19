import { describe, it, expect, vi, beforeEach } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import type { CapitalPosting } from './capital-account'

// R4 (Karl): a GPU SPV accrues no carry at the close. Its profit share is booked only when a
// distribution is declared, so investor statements show paid profit share only. The same books
// under fund terms still accrue.

const at = (lpEntityId: string, capitalDelta: number, sourceType: string, entryDate = '2027-12-31'): CapitalPosting =>
  ({ lpEntityId, amount: -capitalDelta, sourceType, entryDate })

// 1m in, marked up to 3m: a large unrealised gain.
const capitalPostings: CapitalPosting[] = [
  at('a', 1_000_000, 'capital_call', '2027-01-01'),
  at('a', 2_000_000, 'valuation'),
]

vi.mock('./load', async importOriginal => ({
  ...(await importOriginal<typeof import('./load')>()),
  loadPostedLedger: async () => ({ accounts: [], postings: [], capitalPostings, sourcedPostings: [] }),
}))
const persistEntry = vi.fn(async () => ({ entryId: 'carry-1' }))
vi.mock('./persist', async importOriginal => ({
  ...(await importOriginal<typeof import('./persist')>()),
  accountIdByCode: async () => new Map([['3000', 'gpCap']]),
  ensureCapitalAccounts: async () => new Map([['a', 'capA'], ['mgr', 'capMgr']]),
  persistEntry: (...args: unknown[]) => (persistEntry as any)(...args),
}))

import { accrueCarry } from './close'

const admin = (kind: string) => memoryAdmin({
  fund_vehicles: [{ id: 'v1', fund_id: 'f', name: 'GPU I', kind: 'gpu_spv' }],
  vehicle_waterfall_terms: [{
    fund_id: 'f', vehicle_id: 'v1', kind, carry_rate: 0.3, pref_rate: 0.08, catchup_rate: 1, pref_compounds: false,
    gp_entity_id: 'mgr', pref_basis: kind === 'distributable_cash' ? 'unreturned' : 'contributed', pref_day_count: '30_360', roc_lp_share: 1,
  }],
}).admin

beforeEach(() => persistEntry.mockClear())

describe('accrueCarry for a distributable_cash vehicle', () => {
  it('posts no carried_interest entry, however large the unrealised gain', async () => {
    expect(await accrueCarry(admin('distributable_cash'), 'f', 'GPU I', null, '2027-12-31', 'close:p1')).toEqual({})
    expect(persistEntry).not.toHaveBeenCalled()
  })

  it('the same books under european terms still accrue', async () => {
    expect(await accrueCarry(admin('european'), 'f', 'GPU I', null, '2027-12-31', 'close:p1')).toEqual({ entryId: 'carry-1' })
    expect(persistEntry).toHaveBeenCalledTimes(1)
    expect((persistEntry.mock.calls[0] as any[])[4].sourceType).toBe('carried_interest')
  })
})
