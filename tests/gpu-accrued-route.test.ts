import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import type { AccessContext } from '@/lib/access/effective'
import { NO_CARRY } from '@/lib/accounting/carry'
import { GPU_SPV_CHART } from '@/lib/accounting/chart'
import { PACK_INPUTS } from '@/lib/gpu/fixtures/pack-v3'

/**
 * GET /api/accounting/accrued-profit-share: the display memo, gp_economics at the gate and the
 * books' read in the handler; a vehicle that is not a GPU SPV is refused before anything is read.
 */

const FEATURES: FeatureVisibilityMap = { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', gp_economics: 'everyone' }
const access = (grants: AccessContext['grants']): AccessContext => ({
  fundId: 'f1', userId: 'u1', role: 'member', vehicles: { all: true, ids: [] }, features: FEATURES, grants, defaults: {},
})
const mocks = vi.hoisted(() => ({ access: null as any, kind: 'gpu_spv' as string | null, loads: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/api-helpers', () => ({ assertReadAccess: async () => ({ fundId: 'f1', userId: 'u1', role: 'member', need: 'read' }) }))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: async (_a: unknown, _g: unknown, name: string | null) => name }))
vi.mock('@/lib/access/effective', async orig => ({ ...(await orig<typeof import('@/lib/access/effective')>()), loadAccessContext: async () => mocks.access }))
vi.mock('@/lib/accounting/vehicle-domain', async orig => ({
  ...(await orig<typeof import('@/lib/accounting/vehicle-domain')>()),
  assertVehicleKind: async () => (mocks.kind === 'gpu_spv' ? null : (await import('next/server')).NextResponse.json({ error: 'Vehicle not found' }, { status: 404 })),
}))
vi.mock('@/lib/accounting/carry', async orig => ({
  ...(await orig<typeof import('@/lib/accounting/carry')>()),
  loadCarryTerms: async () => { mocks.loads('terms'); return { ...NO_CARRY, kind: 'distributable_cash', prefRate: 0.08, carryRate: 0.3, prefDayCount: '30_360', rocLpShare: 1, recipients: [{ lpEntityId: 'mgr', pct: 100 }] } },
}))
// The pack's Base case after Y2, dated so 30E/360 years are whole (F8): 1,435,500 in on 31 Dec 2026, 766,507.56 and 713,960.08 out.
vi.mock('@/lib/accounting/capital-source', () => ({
  loadCapitalPostings: async () => ({ postings: [
    { lpEntityId: 'lp1', amount: -PACK_INPUTS.capital, sourceType: 'capital_call', entryDate: '2026-12-31' },
    { lpEntityId: 'lp1', amount: 766_507.56, sourceType: 'distribution', entryDate: '2027-12-31' },
    { lpEntityId: 'lp1', amount: 713_960.08, sourceType: 'distribution', entryDate: '2028-12-31' },
  ] }),
}))
vi.mock('@/lib/accounting/load', async orig => ({
  ...(await orig<typeof import('@/lib/accounting/load')>()),
  loadPostedLedger: async () => ({
    accounts: GPU_SPV_CHART.map(a => ({ id: a.code, fundId: 'f1', code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null, lpEntityId: null, companyId: null })),
    postings: [{ accountId: '1000', amount: 1_000_000, currency: 'USD' }],
  }),
}))
vi.mock('@/lib/accounting/distributions', async orig => ({
  ...(await orig<typeof import('@/lib/accounting/distributions')>()),
  loadContingencyByDate: async () => new Map(),
  lastReserve: async () => null,
}))

import { GET } from '@/app/api/accounting/accrued-profit-share/route'
import { ROUTE_DOMAINS, requiredLevel } from '@/lib/access/route-domains'
import { matchRoute } from '@/lib/access/match-route'
import { hasAccess } from '@/lib/access/effective'

const get = (q = 'group=GPU%20SPV%20I&asOf=2028-12-31') => GET(new NextRequest(`http://x/api/accounting/accrued-profit-share?${q}`))

beforeEach(() => { vi.clearAllMocks(); mocks.kind = 'gpu_spv'; mocks.access = access({ accounting: 'read', gp_economics: 'read' }) })

describe('the gate: gp_economics', () => {
  it('denies a member without gp_economics, allows one with it', () => {
    const entry = ROUTE_DOMAINS[matchRoute('/api/accounting/accrued-profit-share')!]
    expect(entry.domain).toBe('gp_economics')
    expect(hasAccess(access({ accounting: 'write', lp_capital: 'read' }), entry.domain, requiredLevel(entry, 'GET') as any, entry.feature)).toBe(false)
    expect(hasAccess(access({ gp_economics: 'read' }), entry.domain, requiredLevel(entry, 'GET') as any, entry.feature)).toBe(true)
  })
})

describe('GET accrued-profit-share', () => {
  it('answers the memo: F7, 1,000,000 of book NAV after Base Y2 accrues 260,226.31 to the manager', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(['asOf', 'bookNav', 'carryMemo', 'investorMemo', 'paidToDate', 'tiers'])
    expect(body).toMatchObject({ asOf: '2028-12-31', bookNav: 1_000_000, carryMemo: 260_226.31, investorMemo: 739_773.69, paidToDate: 0 })
    expect(body.tiers).toMatchObject({ prefDue: 0, returnOfCapital: 132_578.96 })
  })

  it("needs the books' read as well: book NAV is the ledger restated", async () => {
    mocks.access = access({ gp_economics: 'read' })
    expect((await get()).status).toBe(403)
    expect(mocks.loads).not.toHaveBeenCalled()
  })

  it('refuses a vehicle that is not a GPU SPV before reading anything', async () => {
    mocks.kind = 'fund'
    const res = await get('group=Fund%20I')
    expect(res.status).toBe(404)
    expect(mocks.loads).not.toHaveBeenCalled()
  })

  it('refuses a malformed asOf', async () => {
    expect((await get('group=GPU%20SPV%20I&asOf=last-week')).status).toBe(400)
  })
})
