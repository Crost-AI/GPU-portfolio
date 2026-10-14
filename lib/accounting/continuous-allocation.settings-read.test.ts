import { describe, it, expect, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import type { Account, JournalEntry } from './types'

// A failed allocation-settings read must refuse the allocation, not allocate on the defaults
// (commitment basis, no side letters) — that allocation would balance and nothing would notice.
vi.mock('./vehicle-id', () => ({ vehicleIdByName: async () => 'v', vehicleNameById: async () => 'Fund I' }))
vi.mock('./vehicle-domain', () => ({ vehicleKindByName: async () => 'fund' }))

const accounts: Account[] = [
  { id: 'cash', fundId: 'f', code: '1000', name: 'Cash', type: 'asset', subtype: 'cash' },
  { id: 'bridge', fundId: 'f', code: '3200', name: 'Undistributed earnings', type: 'equity', subtype: 'undistributed_earnings' },
  { id: 'interest', fundId: 'f', code: '4100', name: 'Interest income', type: 'income', subtype: 'interest_income' },
]
vi.mock('./load', async importOriginal => ({
  ...(await importOriginal<typeof import('./load')>()),
  loadPostedLedger: async () => ({ accounts, postings: [], capitalPostings: [], sourcedPostings: [] }),
  loadOwnership: async () => [{ lpEntityId: 'a', commitment: 600 }, { lpEntityId: 'b', commitment: 400 }],
  loadEntityNames: async () => new Map([['a', 'A'], ['b', 'B']]),
}))
vi.mock('./terms', async importOriginal => ({
  ...(await importOriginal<typeof import('./terms')>()),
  loadAllocationBasis: async () => { throw new Error('vehicle_accounting_settings read failed: boom') },
  loadPartnerTerms: async () => [],
  loadCommitmentEvents: async () => [],
}))
const persistEntry = vi.fn()
vi.mock('./persist', () => ({
  accountIdByCode: async () => new Map(accounts.map(a => [a.code, a.id])),
  ensureCapitalAccounts: async () => new Map(),
  persistEntry: (...args: unknown[]) => persistEntry(...args),
}))

import { allocatePostedEntry } from './continuous-allocation'

describe('allocatePostedEntry on a failed settings read', () => {
  it('returns an error and posts nothing', async () => {
    const entry: JournalEntry = {
      fundId: 'f', entryDate: '2026-03-10', sourceType: 'manual', memo: 'Interest',
      postings: [
        { accountId: 'cash', amount: 100, currency: 'USD', lpEntityId: null },
        { accountId: 'interest', amount: -100, currency: 'USD', lpEntityId: null },
      ],
    }
    const out = await allocatePostedEntry(memoryAdmin().admin, 'f', 'Fund I', 'u', 'e1', entry)
    expect(out).toEqual({ error: expect.stringMatching(/vehicle_accounting_settings read failed: boom/) })
    expect(persistEntry).not.toHaveBeenCalled()
  })
})
