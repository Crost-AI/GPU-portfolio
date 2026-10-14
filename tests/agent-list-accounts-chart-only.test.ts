import { describe, it, expect, vi } from 'vitest'

// list_accounts answers from the chart; it has no use for the postings.
vi.mock('@/lib/accounting/load', async (orig) => ({
  ...(await orig<any>()),
  loadPostedLedger: vi.fn(async () => { throw new Error('list_accounts must not load the ledger') }),
}))
vi.mock('@/lib/accounting/chart-load', () => ({
  loadChart: vi.fn(async () => [{ id: 'a1', fundId: 'f1', code: '1000', name: 'Cash', type: 'asset', subtype: 'cash', lpEntityId: null, companyId: null }]),
}))
import { getTool } from '@/lib/accounting/agent-tools'
import { loadPostedLedger } from '@/lib/accounting/load'
import { loadChart } from '@/lib/accounting/chart-load'

describe('list_accounts', () => {
  it('reads the chart, not the posted ledger', async () => {
    const admin = {} as any
    const out = await getTool('list_accounts')!.handler({ admin, fundId: 'f1', portfolioGroup: 'Fund I', userId: 'u1', access: {} as any }, {})
    expect(out).toEqual([{ code: '1000', name: 'Cash', type: 'asset', subtype: 'cash' }])
    expect(loadChart).toHaveBeenCalledWith(admin, 'f1', 'Fund I')
    expect(loadPostedLedger).not.toHaveBeenCalled()
  })
})
