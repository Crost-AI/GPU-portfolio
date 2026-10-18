import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

/**
 * #82: a source_ref is the system's tag, and several code paths trust it (the GPU fleet adopts a
 * `gpu-asset:` entry as its own purchase or disposal; `reversal:<id>` says what an entry undoes). The
 * journal API refuses a user-supplied ref in a reserved namespace before anything is written.
 */

const s = vi.hoisted(() => ({ m: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', () => ({
  assertWriteAccess: async () => ({ fundId: 'f', userId: 'u', role: 'admin', need: 'write' }),
  assertReadAccess: async () => ({ fundId: 'f', userId: 'u', role: 'admin', need: 'read' }),
}))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: async (_a: any, _g: any, raw: string) => raw }))
vi.mock('@/lib/accounting/persist', async orig => ({ ...(await orig<any>()), persistEntry: vi.fn(async () => ({ entryId: 'je-1' })) }))

import { POST } from '@/app/api/accounting/journal/route'
import { persistEntry } from '@/lib/accounting/persist'
import { RESERVED_SOURCE_REF_PREFIXES, isReservedSourceRef } from '@/lib/accounting/reserved-refs'

beforeEach(() => {
  vi.clearAllMocks()
  s.m = memoryAdmin({ fund_settings: [{ fund_id: 'f', currency: 'USD' }], journal_entries: [], vendors: [] })
})

const post = (sourceRef: unknown) => POST(new NextRequest('https://x.test/api/accounting/journal', {
  method: 'POST',
  body: JSON.stringify({ group: 'H200 SPV I', entryDate: '2027-01-05', sourceRef, postings: [{ accountId: 'a', amount: 1 }, { accountId: 'b', amount: -1 }] }),
}))

describe('reserved source refs', () => {
  it('covers the fleet, allocation, intercompany and reversal namespaces', () => {
    expect([...RESERVED_SOURCE_REF_PREFIXES]).toEqual(expect.arrayContaining(['gpu-asset:', 'gpu-dep:', 'fleet:', 'allocation:', 'intercompany:', 'reversal:']))
    expect(isReservedSourceRef('gpu-asset:abc:purchase')).toBe(true)
    expect(isReservedSourceRef('  GPU-DEP:abc:2027-01')).toBe(true)
    expect(isReservedSourceRef('agent-allocation:x:y')).toBe(true)
    expect(isReservedSourceRef('intercompany-settlement:c1')).toBe(true)
    expect(isReservedSourceRef('INV-4471')).toBe(false)
    expect(isReservedSourceRef(null)).toBe(false)
  })

  it.each(['gpu-asset:a1:purchase', 'gpu-dep:a1:2027-01', 'fleet:insurance:P:2027-01-01', 'reversal:je-9', 'intercompany:c1', 'allocation:x'])(
    'POST /api/accounting/journal refuses %s before writing anything', async ref => {
      const r = await post(ref)
      expect(r.status).toBe(400)
      expect((await r.json()).error).toMatch(/reserved/)
      expect(persistEntry).not.toHaveBeenCalled()
    })

  it('an ordinary reference still posts', async () => {
    expect((await post('bank:2027-01-05:42')).status).not.toBe(400)
    expect(persistEntry).toHaveBeenCalledOnce()
  })
})
