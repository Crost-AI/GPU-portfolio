import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

// ── GPU fleet (P3) ── The operations namespaces are reserved (#82, modelled on
// tests/journal-reserved-refs.test.ts): postEarnings completes an earnings row from the posted
// `marketplace:<id>` entry and matchPayout a payout from `marketplace-payout:<id>`, so a hand-typed
// entry under either ref would forge "booked" for a row the subledger never posted.

const s = vi.hoisted(() => ({ m: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', () => ({
  assertWriteAccess: async () => ({ fundId: 'f', userId: 'u', role: 'admin', need: 'write' }),
  assertReadAccess: async () => ({ fundId: 'f', userId: 'u', role: 'admin', need: 'read' }),
}))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: async (_a: any, _g: any, raw: string) => raw }))
vi.mock('@/lib/access/effective', async orig => ({ ...(await orig<any>()), loadAccessContext: async () => ({ grants: {}, defaults: {}, features: {}, role: 'admin', vehicles: { all: true, ids: [] } }) }))
vi.mock('@/lib/accounting/persist', async orig => ({ ...(await orig<any>()), persistEntry: vi.fn(async () => ({ entryId: 'je-1' })) }))

import { POST } from '@/app/api/accounting/journal/route'
import { persistEntry } from '@/lib/accounting/persist'
import { RESERVED_SOURCE_REF_PREFIXES, assertUserRefAllowed } from '@/lib/accounting/reserved-refs'

beforeEach(() => {
  vi.clearAllMocks()
  s.m = memoryAdmin({
    fund_settings: [{ fund_id: 'f', currency: 'USD' }], vendors: [], journal_postings: [], journal_entries: [],
    fund_vehicles: [{ id: 'v', fund_id: 'f', name: 'GPU I', kind: 'gpu_spv', aliases: [] }],
  })
})

const journal = (sourceRef: string) => new NextRequest('https://x.test/api/accounting/journal', {
  method: 'POST',
  body: JSON.stringify({ group: 'GPU I', entryDate: '2026-09-30', sourceRef, postings: [{ accountId: 'a', amount: 1 }, { accountId: 'b', amount: -1 }] }),
})

describe('GPU operations refs are reserved', () => {
  it('lists marketplace: and marketplace-payout:', () => {
    expect([...RESERVED_SOURCE_REF_PREFIXES]).toEqual(expect.arrayContaining(['marketplace:', 'marketplace-payout:']))
  })

  it.each(['marketplace:e-1', 'marketplace-payout:p-1', ' Marketplace:E-1', 'MARKETPLACE-PAYOUT:p-1'])('journal POST refuses %s before writing', async ref => {
    expect(assertUserRefAllowed(ref)).toMatch(/reserved/)
    const res = await POST(journal(ref))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/reserved/)
    expect(persistEntry).not.toHaveBeenCalled()
  })

  it('an ordinary marketplace invoice number is still a user ref', async () => {
    expect(assertUserRefAllowed('marketplace-inv-0042')).toBeNull()
  })
})
