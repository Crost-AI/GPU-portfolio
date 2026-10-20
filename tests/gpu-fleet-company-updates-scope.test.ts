import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import type { AccessContext } from '@/lib/access/effective'

// ── GPU fleet (P3) ── Codex r3 on #98: hiding the fleet company turns "every company" into an
// explicit id list. That list is an internal scope, applied after the request is parsed, so a fund
// with more than 200 other companies still searches — while a REQUESTED company_ids list keeps its
// 200-id cap. The real parser and search module run; only the RPC is captured.

const s = vi.hoisted(() => ({ m: null as any, ctx: null as any, rpc: [] as any[] }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) }, from: (t: string) => s.m.admin.from(t) }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/access/effective', async orig => ({ ...(await orig<any>()), loadAccessContext: async () => s.ctx }))

import { GET as search } from '@/app/api/company-updates/search/route'
import { PORTFOLIO_HANDLERS } from '@/lib/agent/portfolio-tools'
import { parseSearchParams, SearchParamsError } from '@/lib/company-updates/search'

const ctx = (fleet: 'none' | 'read'): AccessContext => ({
  fundId: 'f', userId: 'u', role: 'member', vehicles: { all: true, ids: [] },
  features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', gpu_fleet: 'everyone' } as FeatureVisibilityMap,
  grants: { portfolio: 'write', accounting: 'read', fleet }, defaults: {},
})
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const FLEET = uuid(999)
const VC = Array.from({ length: 201 }, (_, i) => uuid(i + 1))

beforeEach(() => {
  s.ctx = ctx('none')
  s.rpc = []
  s.m = memoryAdmin({
    fund_members: [{ fund_id: 'f', user_id: 'u', role: 'member' }],
    fund_vehicles: [], fund_member_vehicles: [],
    companies: [
      { id: FLEET, fund_id: 'f', name: 'Fleet — GPU I', holding_type: 'gpu_fleet' },
      ...VC.map((id, i) => ({ id, fund_id: 'f', name: `Co ${i}`, holding_type: 'company' })),
    ],
  })
  s.m.admin.rpc = async (name: string, args: any) => {
    s.rpc.push({ name, args })
    return { data: { total: 0, results: [], next_cursor: null, match_mode: 'lexical', order: 'newest' }, error: null }
  }
})

const req = (url: string) => new NextRequest(`http://localhost${url}`)
const sentIds = () => {
  expect(s.rpc).toHaveLength(1)
  expect(s.rpc[0].name).toBe('company_updates_search')
  return s.rpc[0].args.p_company_ids as string[] | null
}

describe('the hidden-fleet scope is not subject to the requested-ids cap', () => {
  it('search: 201 visible companies + a hidden fleet company → the RPC gets all 201 and not the fleet', async () => {
    const res = await search(req('/api/company-updates/search?q=gross'))
    expect(res.status).toBe(200)
    const ids = sentIds()!
    expect(ids).toHaveLength(201)
    expect(ids).not.toContain(FLEET)
    expect([...ids].sort()).toEqual([...VC].sort())
  })

  it('search: with fleet read nothing is hidden, so the RPC is not narrowed at all', async () => {
    s.ctx = ctx('read')
    expect((await search(req('/api/company-updates/search?q=gross'))).status).toBe(200)
    expect(sentIds()).toBeNull()
  })

  it('search: a requested company_ids list above 200 is still refused', async () => {
    const res = await search(req(`/api/company-updates/search?q=gross&company_ids=${VC.join(',')}`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('at most 200 company ids')
    expect(s.rpc).toHaveLength(0)
    expect(() => parseSearchParams('f', { company_ids: VC })).toThrow(SearchParamsError)
  })

  it('search: a requested list is intersected with the scope — the fleet company drops out', async () => {
    const res = await search(req(`/api/company-updates/search?q=gross&company_ids=${FLEET},${VC[0]}`))
    expect(res.status).toBe(200)
    expect(sentIds()).toEqual([VC[0]])
  })

  it('get_updates: the same 201 reach the RPC, without the fleet company', async () => {
    const out = await (PORTFOLIO_HANDLERS.get_updates as any)({ admin: s.m.admin, fundId: 'f', access: ctx('none') }, { mode: 'search', query: 'revenue' })
    expect(out.exact_total).toBe(0)
    const ids = sentIds()!
    expect(ids).toHaveLength(201)
    expect(ids).not.toContain(FLEET)
  })
})
