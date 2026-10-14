import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// PATCH /api/accounting/receipts/[id] { action: 'draft' } forwards reportingAmount, and refuses one
// that is not a positive number before anything is drafted.
const s = vi.hoisted(() => ({ draft: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/api-helpers', async (orig) => ({ ...(await orig<any>()), assertWriteAccess: async () => ({ fundId: 'f1', userId: 'u1', role: 'member', need: 'write' }) }))
vi.mock('@/lib/accounting/receipt-access', () => ({ authorizeReceipt: async () => ({ group: 'Fund I' }) }))
vi.mock('@/lib/accounting/receipts', async (orig) => ({
  ...(await orig<any>()),
  getReceipt: async () => ({ id: 'r1', vehicle_id: 'v1', amount: 100, currency: 'EUR' }),
  draftEntryFromReceipt: s.draft,
}))
import { PATCH } from '@/app/api/accounting/receipts/[id]/route'

const patch = (body: Record<string, unknown>) => PATCH(
  new NextRequest('http://x/api/accounting/receipts/r1', { method: 'PATCH', body: JSON.stringify({ action: 'draft', debitAccountId: 'travel', creditAccountId: 'card', ...body }) }),
  { params: Promise.resolve({ id: 'r1' }) },
)

describe('drafting a receipt through the route', () => {
  beforeEach(() => { s.draft.mockReset(); s.draft.mockResolvedValue({ entryId: 'e1', receipt: {} }) })

  it('passes reportingAmount through to the draft', async () => {
    expect((await patch({ reportingAmount: 108.5 })).status).toBe(200)
    expect(s.draft).toHaveBeenCalledWith(expect.anything(), 'f1', 'Fund I', 'v1', 'u1', 'r1', expect.objectContaining({ reportingAmount: 108.5 }))
  })

  it('passes null when it is absent, so a same-currency receipt drafts as before', async () => {
    expect((await patch({})).status).toBe(200)
    expect(s.draft).toHaveBeenCalledWith(expect.anything(), 'f1', 'Fund I', 'v1', 'u1', 'r1', expect.objectContaining({ reportingAmount: null }))
  })

  it.each([0, -5, '108.50', 'abc', true, {}])('refuses reportingAmount %j without drafting', async value => {
    const res = await patch({ reportingAmount: value })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'reportingAmount must be a positive number' })
    expect(s.draft).not.toHaveBeenCalled()
  })
})
