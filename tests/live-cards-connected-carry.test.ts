import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { DEFAULT_FEATURE_VISIBILITY } from '@/lib/types/features'

// Crost #139: the live cards are gated on lp_capital. Connected-fund positions follow the rules the
// investor report's PDF applies: without gp_economics, none on which the LP receives carry in that
// fund, and only for a caller who sees every entity.

const s = vi.hoisted(() => ({ m: null as any, scope: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', async (orig) => ({ ...(await orig<any>()), assertReadAccess: async () => ({ fundId: 'home', userId: 'u', role: 'member' }) }))
vi.mock('@/lib/access/entity-scope', async (orig) => ({ ...(await orig<any>()), loadEntityScope: async () => s.scope }))
vi.mock('@/lib/access/carry-visibility', async (orig) => ({ ...(await orig<any>()), carryRecipientIds: async () => new Set(['e-gp']) }))
vi.mock('@/lib/accounting/lp-positions', async (orig) => ({ ...(await orig<any>()), lastDataDates: async (_d: unknown, _f: string, g: string[]) => new Map(g.map(x => [x, '2026-06-30'])) }))
vi.mock('@/lib/accounting/live-report', () => ({
  generateLiveReport: async (_d: unknown, fundId: string) => ({
    asOf: '2026-06-30', entityNames: new Map(),
    rows: fundId === 'home'
      ? [{ entity_id: 'e-home', portfolio_group: 'Fund I', commitment: 100, nav: 10 }]
      : [
          { entity_id: 'e-lp', portfolio_group: 'Fund A', commitment: 100, nav: 20 },
          { entity_id: 'e-gp', portfolio_group: 'Fund A', commitment: 100, nav: 30 },
        ],
  }),
}))
import { GET } from '@/app/api/lps/live-cards/route'

const access = (gp: 'none' | 'read') => ({
  fundId: 'home', userId: 'u', role: 'member', vehicles: { all: true, ids: [] }, defaults: {},
  features: Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])),
  grants: { lp_capital: 'read', gp_economics: gp },
})

beforeEach(() => {
  s.m = memoryAdmin({
    funds: [{ id: 'home', name: 'Home Fund' }, { id: 'other', name: 'Other Fund' }],
    fund_settings: [{ fund_id: 'home', currency: 'USD' }, { fund_id: 'other', currency: 'USD' }],
    lp_entities: [
      { id: 'e-home', fund_id: 'home', entity_name: 'Example LP', investor_id: 'inv-1' },
      { id: 'e-lp', fund_id: 'other', entity_name: 'Example LP', investor_id: 'their-1' },
      { id: 'e-gp', fund_id: 'other', entity_name: 'Example GP', investor_id: 'their-1' },
    ],
    fund_connections: [{ id: 'c1', requester_fund_id: 'home', recipient_fund_id: 'other', status: 'active' }],
    lp_investor_links: [{ id: 'l1', connection_id: 'c1', requester_investor_id: 'inv-1', recipient_investor_id: 'their-1', requester_approved_at: '2026-01-01', recipient_approved_at: '2026-01-01', approved: true }],
  })
})

const navs = async () => {
  const body = await (await GET(new NextRequest('http://localhost/api/lps/live-cards'))).json()
  return body.investors.flatMap((i: any) => i.rows.map((r: any) => r.nav)).sort((a: number, b: number) => a - b)
}

describe('connected positions on the live cards', () => {
  it('without gp_economics: leaves out the position on which the LP receives carry', async () => {
    s.scope = { access: access('none'), vehicleNames: null, companyIds: null }
    expect(await navs()).toEqual([10, 20])
  })

  it('with gp_economics: shows it', async () => {
    s.scope = { access: access('read'), vehicleNames: null, companyIds: null }
    expect(await navs()).toEqual([10, 20, 30])
  })

  it('for a caller who sees some entities: adds no connected position', async () => {
    s.scope = { access: access('read'), vehicleNames: ['Fund I'], companyIds: [] }
    expect(await navs()).toEqual([10])
  })
})
