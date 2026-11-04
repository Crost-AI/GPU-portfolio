import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// The ILPA CCD download (upstream #157) is gated on lp_capital. A distribution's carry lines are GP
// economics: without gp_economics read the file leaves them out, and nothing in it (the notice total,
// a recipient's earlier distributions) lets them be worked out (Codex on #126; Crost #87).

const s = vi.hoisted(() => ({ access: null as any }))
const DIST = {
  noticeDate: '2026-06-30', description: 'Exit proceeds', numberLabel: 2, dueDate: null, tiers: null,
  lines: [
    { id: 'l1', lpEntityId: 'lp-a', amount: 90_000, role: 'lp' },
    { id: 'l2', lpEntityId: 'gp-1', amount: 10_000, role: 'lp' },
    { id: 'l3', lpEntityId: 'gp-1', amount: 18_000, role: 'carry' },
  ],
}
vi.mock('@/lib/accounting/notice-register', () => ({ loadNoticeRegister: async () => DIST }))
vi.mock('@/lib/accounting/capital-calls', () => ({
  lpCapitalSummary: async () => [
    { lpEntityId: 'lp-a', name: 'Example LP', commitment: 900_000, partnerClass: 'lp' },
    { lpEntityId: 'gp-1', name: 'Example GP', commitment: 100_000, partnerClass: 'gp' },
  ],
  listCapitalCalls: async () => [],
}))
vi.mock('@/lib/accounting/distributions', () => ({
  listDistributions: async () => [
    { distributionId: 'd1', date: '2026-01-31', kind: 'cash', lines: [
      { id: 'p1', lpEntityId: 'gp-1', amount: 5_000, role: 'lp' },
      { id: 'p2', lpEntityId: 'gp-1', amount: 7_000, role: 'carry' },
    ] },
    { distributionId: 'd2', date: '2026-06-30', kind: 'cash', lines: DIST.lines.map(l => ({ ...l })) },
  ],
}))
vi.mock('@/lib/accounting/call-extras', () => ({ callExtras: async () => new Map(), distributionDeductions: async () => new Map() }))
vi.mock('@/lib/accounting/vehicle-id', () => ({ vehicleIdByName: async () => 'v1' }))
vi.mock('@/lib/vehicle-letterhead', () => ({ documentLetterhead: async () => ({ name: 'Example Fund I' }) }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => admin }))
vi.mock('@/lib/api-helpers', async (orig) => ({ ...(await orig<any>()), assertReadAccess: async () => ({ fundId: 'f', userId: 'u', role: 'member' }) }))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: async () => 'Fund I' }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: async () => null }))
vi.mock('@/lib/access/effective', async (orig) => ({ ...(await orig<any>()), loadAccessContext: async () => s.access }))

const admin = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) } as any

import { loadCcdNotices } from '@/lib/ilpa/ccd-load'
import { DEFAULT_FEATURE_VISIBILITY } from '@/lib/types/features'
import { ILPA_HANDLERS } from '@/lib/agent/ilpa-tools'
import { GET } from '@/app/api/accounting/notices/ilpa/route'

const member = (gp: 'none' | 'read') => ({
  fundId: 'f', userId: 'u', role: 'member', features: Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])),
  grants: { lp_capital: 'read', gp_economics: gp }, defaults: {},
  vehicles: { all: true, ids: [] },
})
const amounts = (n: any) => JSON.stringify(n)

beforeEach(() => { s.access = member('none') })

describe('ILPA CCD carry lines need GP economics', () => {
  it('without it: no carry line, and the total and prior distributions count partners\' lines only', async () => {
    const out = await loadCcdNotices(admin, 'f', 'Fund I', 'distribution', 'd2', null, false)
    if (!out.ok) throw new Error(out.error)
    expect(out.notices).toHaveLength(2)
    const text = amounts(out.notices)
    expect(text).not.toMatch(/18000|7000|128000/)
    expect(text).toMatch(/100000/) // the notice total, partners' lines only
    // The carry recipient asked for by id: its partner line, without the carry.
    const gp = await loadCcdNotices(admin, 'f', 'Fund I', 'distribution', 'd2', 'gp-1', false)
    if (!gp.ok) throw new Error(gp.error)
    expect(gp.notices).toHaveLength(1)
    expect(amounts(gp.notices)).not.toMatch(/18000|7000/)
  })

  it('with it: the carry line and the full total are there', async () => {
    const out = await loadCcdNotices(admin, 'f', 'Fund I', 'distribution', 'd2', null, true)
    if (!out.ok) throw new Error(out.error)
    expect(out.notices).toHaveLength(3)
    expect(amounts(out.notices)).toMatch(/18000/)
  })

  it('the route and the agent tool pass the caller\'s GP-economics access', async () => {
    const res = await GET(new NextRequest('http://localhost/api/accounting/notices/ilpa?group=Fund%20I&kind=distribution&id=d2&format=json'))
    expect(res.status).toBe(200)
    expect(amounts(await res.json())).not.toMatch(/18000/)
    const tool = await ILPA_HANDLERS.ilpa_notice_data({ admin, fundId: 'f', portfolioGroup: 'Fund I', access: s.access } as any, { kind: 'distribution', id: 'd2' })
    expect(amounts(tool)).not.toMatch(/18000/)

    s.access = member('read')
    const seen = await GET(new NextRequest('http://localhost/api/accounting/notices/ilpa?group=Fund%20I&kind=distribution&id=d2&format=json'))
    expect(amounts(await seen.json())).toMatch(/18000/)
  })
})
