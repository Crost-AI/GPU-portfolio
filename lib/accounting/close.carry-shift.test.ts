import { describe, it, expect, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import type { CapitalPosting } from './capital-account'

// Carry can move between paying LPs with the recipients' total unchanged: one LP falls under
// water and hands its carry back while another's gain grows into exactly that much. The fund-level
// delta is zero, but the per-LP postings are not — the close must still book them.

// Capital accounts are credit-normal: a posting of −x adds x to the partner's capital.
const at = (lpEntityId: string, capitalDelta: number, sourceType: string, entryDate = '2026-03-31'): CapitalPosting =>
  ({ lpEntityId, amount: -capitalDelta, sourceType, entryDate })

// A and B each put in 1m and each bore 100k of carry (GP holds 200k). A is now 900k gross (−100k),
// B 2.1m gross (+1.1m): fund profit 1m → target 200k, all of it B's. A gets 100k back, B tops up 100k.
const capitalPostings: CapitalPosting[] = [
  at('a', 1_000_000, 'capital_call', '2026-01-15'), at('b', 1_000_000, 'capital_call', '2026-01-15'),
  at('a', 1_000_000, 'valuation', '2026-03-31'), at('b', 1_000_000, 'valuation', '2026-03-31'),
  at('a', -100_000, 'carried_interest', '2026-03-31'), at('b', -100_000, 'carried_interest', '2026-03-31'),
  at('gp', 200_000, 'carried_interest', '2026-03-31'),
  at('a', -1_100_000, 'valuation', '2026-06-30'), at('b', 100_000, 'valuation', '2026-06-30'),
]

vi.mock('./load', async importOriginal => ({
  ...(await importOriginal<typeof import('./load')>()),
  loadPostedLedger: async () => ({ accounts: [], postings: [], capitalPostings, sourcedPostings: [] }),
}))
const persistEntry = vi.fn(async () => ({ entryId: 'carry-1' }))
vi.mock('./persist', async importOriginal => ({
  ...(await importOriginal<typeof import('./persist')>()),
  accountIdByCode: async () => new Map([['3000', 'gpCap']]),
  ensureCapitalAccounts: async () => new Map([['a', 'capA'], ['b', 'capB'], ['gp', 'capGp']]),
  persistEntry: (...args: unknown[]) => (persistEntry as any)(...args),
}))

import { accrueCarry } from './close'

describe('accrueCarry when carry shifts between LPs', () => {
  it('posts the shift even though the total accrued is unchanged', async () => {
    const m = memoryAdmin({
      fund_vehicles: [{ id: 'v1', fund_id: 'f', name: 'Fund I' }],
      vehicle_waterfall_terms: [{ fund_id: 'f', vehicle_id: 'v1', kind: 'straight', carry_rate: 0.2, gp_entity_id: 'gp' }],
    })
    const out = await accrueCarry(m.admin, 'f', 'Fund I', null, '2026-06-30', 'close:p2')
    expect(out).toEqual({ entryId: 'carry-1' })
    expect(persistEntry).toHaveBeenCalledTimes(1)
    const entry = (persistEntry.mock.calls[0] as any[])[4]
    expect(entry.sourceRef).toBe('close:p2')
    expect(entry.postings.map((p: any) => [p.accountId, p.amount])).toEqual([['capA', -100_000], ['capB', 100_000]])
  })
})
