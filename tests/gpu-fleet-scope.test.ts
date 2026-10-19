import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { DEFAULT_FEATURE_VISIBILITY } from '@/lib/types/features'

/**
 * ── GPU fleet (P1) ── The fleet routes through the REAL entity resolver (resolveGroupWithAccess:
 * vehicle resolution, entity visibility, the vehicle's domain). Only the access_context RPC is
 * stubbed: an entity outside the caller's scope is refused, and an access context that cannot be
 * read fails closed with nothing written.
 */

const s = vi.hoisted(() => ({ m: null as any, access: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', () => ({
  assertReadAccess: async () => ({ fundId: 'f', userId: 'u', role: 'member', need: 'read' }),
  assertWriteAccess: async () => ({ fundId: 'f', userId: 'u', role: 'member', need: 'write' }),
}))
vi.mock('@/lib/access/effective', async orig => {
  const real = await orig<any>()
  // 'real' runs the actual loader against the memory admin, whose access_context RPC fails.
  return { ...real, loadAccessContext: async (...a: any[]) => (s.access === 'real' ? real.loadAccessContext(...a) : s.access) }
})

import * as assets from '@/app/api/fleet/assets/route'
import * as purchase from '@/app/api/fleet/assets/[id]/purchase/route'

const GPU = 'aaaaaaaa-0000-4000-8000-000000000001'
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'
const ASSET = 'cccccccc-0000-4000-8000-000000000003'
const ctx = (ids: string[], all = false) => ({
  fundId: 'f', userId: 'u', role: 'member', vehicles: { all, ids }, defaults: {},
  grants: { fleet: 'write', accounting: 'write' }, features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', gpu_fleet: 'everyone' },
})

beforeEach(() => {
  s.m = memoryAdmin({
    fund_vehicles: [
      { id: GPU, fund_id: 'f', name: 'H200 SPV I', kind: 'gpu_spv', aliases: [], active: true },
      { id: OTHER, fund_id: 'f', name: 'H200 SPV II', kind: 'gpu_spv', aliases: [], active: true },
    ],
    gpu_assets: [{ id: ASSET, fund_id: 'f', vehicle_id: GPU, name: 'H200 #1', status: 'ordered', gpu_count: 8, hardware_cost: 335_000, purchase_entry_id: null }],
    chart_of_accounts: [], journal_entries: [], journal_postings: [], journal_lines: [],
  })
})

const create = () => assets.POST(new NextRequest('https://x.test/api/fleet/assets', { method: 'POST', body: JSON.stringify({ group: 'H200 SPV I', name: 'x', gpu_count: 8, hardware_cost: 1 }) }))

describe('entity scope through the real resolver', () => {
  it('serves a GPU SPV the caller is granted', async () => {
    s.access = ctx([GPU])
    expect((await assets.GET(new NextRequest('https://x.test/api/fleet/assets?group=H200 SPV I'))).status).toBe(200)
  })

  it('refuses a GPU SPV outside the caller\'s entity grants, by group and by row, writing nothing', async () => {
    s.access = ctx([OTHER])
    const listed = await assets.GET(new NextRequest('https://x.test/api/fleet/assets?group=H200 SPV I'))
    expect([403, 404]).toContain(listed.status)
    expect([403, 404]).toContain((await create()).status)
    const bought = await purchase.POST(new NextRequest(`https://x.test/api/fleet/assets/${ASSET}/purchase`, { method: 'POST', body: JSON.stringify({ entryDate: '2027-01-05' }) }), { params: Promise.resolve({ id: ASSET }) })
    expect([403, 404]).toContain(bought.status)
    expect(s.m.tables.gpu_assets).toHaveLength(1)
    expect(s.m.tables.journal_entries).toEqual([])
  })

  it('fails closed when the access context cannot be read (the real loader, a failing RPC)', async () => {
    s.access = 'real'
    const r = await create()
    expect(r.status).toBe(403)
    const bought = await purchase.POST(new NextRequest(`https://x.test/api/fleet/assets/${ASSET}/purchase`, { method: 'POST', body: JSON.stringify({ entryDate: '2027-01-05' }) }), { params: Promise.resolve({ id: ASSET }) })
    expect(bought.status).toBe(403)
    expect(s.m.tables.gpu_assets).toHaveLength(1)
    expect(s.m.tables.journal_entries).toEqual([])
  })
})
