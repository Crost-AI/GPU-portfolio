import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

// ── GPU fleet (P3 PR B) ── POST /api/fleet/kpis (publish), /api/fleet/ops/settings (#92), and the
// default-metrics listings filtered by holding type.

const s = vi.hoisted(() => ({ m: null as any, accountingWrite: true }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/activity', () => ({ logActivity: vi.fn() }))
vi.mock('@/lib/api-helpers', async orig => ({ ...(await orig<any>()), assertWriteAccess: async () => ({ fundId: 'f', userId: 'u', role: 'member', need: 'write' }), assertReadAccess: async () => ({ fundId: 'f', userId: 'u', role: 'member', need: 'read' }) }))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupWithAccess: async (_a: unknown, _g: unknown, requested: string | null) => ({ group: requested ?? 'GPU I', access: {} }) }))
vi.mock('@/lib/access/effective', async orig => ({
  ...(await orig<any>()),
  hasAccess: (_ctx: unknown, domain: string, need: string) => !(domain === 'accounting' && need === 'write') || s.accountingWrite,
}))

import { POST as publish } from '@/app/api/fleet/kpis/route'
import { GET as getSettings, PATCH as patchSettings } from '@/app/api/fleet/ops/settings/route'
import { GET as listDefaults } from '@/app/api/default-metrics/route'
import { GET as companyDefaults } from '@/app/api/companies/[id]/default-metrics/route'

const req = (url: string, method = 'GET', body?: object) => new NextRequest(`http://localhost${url}`, body ? { method, body: JSON.stringify(body) } : { method })

beforeEach(() => {
  s.accountingWrite = true
  s.m = memoryAdmin({
    fund_vehicles: [
      { id: 'v-gpu', fund_id: 'f', name: 'GPU I', kind: 'gpu_spv', aliases: [] },
      { id: 'v-fund', fund_id: 'f', name: 'Fund I', kind: 'fund', aliases: [] },
    ],
    fund_members: [{ fund_id: 'f', user_id: 'u', role: 'admin' }],
    gpu_assets: [], gpu_asset_types: [], gpu_earnings: [], gpu_import_runs: [], gpu_fleet_settings: [],
    companies: [
      { id: 'vc', fund_id: 'f', name: 'Acme', holding_type: 'company', portfolio_group: ['Fund I'] },
      { id: 'fleet', fund_id: 'f', name: 'Fleet — GPU I', holding_type: 'gpu_fleet', portfolio_group: ['GPU I'], status: 'active' },
    ],
    default_metrics: [
      { id: 'dm-mrr', fund_id: 'f', name: 'MRR', slug: 'mrr', is_active: true, display_order: 0, holding_type: 'company' },
      { id: 'dm-gpu', fund_id: 'f', name: 'GPU utilization', slug: 'gpu-utilization', is_active: true, display_order: 0, holding_type: 'gpu_fleet' },
    ],
    metrics: [], metric_values: [], default_metric_exclusions: [],
  }, { unique: [{ table: 'gpu_fleet_settings', key: r => r.vehicle_id }] })
})

describe('POST /api/fleet/kpis', () => {
  it('publishes the month to the fleet company', async () => {
    const res = await publish(req('/api/fleet/kpis', 'POST', { group: 'GPU I', month: '2026-09', action: 'publish' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ companyId: 'fleet', month: '2026-09' })
  })

  it('refuses a fund vehicle (404), an unknown action and a malformed month (400)', async () => {
    expect((await publish(req('/api/fleet/kpis', 'POST', { group: 'Fund I', month: '2026-09', action: 'publish' }))).status).toBe(404)
    expect((await publish(req('/api/fleet/kpis', 'POST', { group: 'GPU I', month: '2026-09', action: 'recompute' }))).status).toBe(400)
    expect((await publish(req('/api/fleet/kpis', 'POST', { group: 'GPU I', month: 'Sept', action: 'publish' }))).status).toBe(400)
  })
})

describe('/api/fleet/ops/settings (#92)', () => {
  it('auto-posting is off until turned on, and turning it on needs accounting write', async () => {
    expect(await (await getSettings(req('/api/fleet/ops/settings?group=GPU%20I'))).json()).toEqual({ autoPostPayoutMatches: false })
    s.accountingWrite = false
    const denied = await patchSettings(req('/api/fleet/ops/settings', 'PATCH', { group: 'GPU I', autoPostPayoutMatches: true }))
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: 'Changing how payouts are booked needs write access to Fund accounting.' })
    s.accountingWrite = true
    expect((await patchSettings(req('/api/fleet/ops/settings', 'PATCH', { group: 'GPU I', autoPostPayoutMatches: true }))).status).toBe(200)
    expect(s.m.tables.gpu_fleet_settings).toEqual([expect.objectContaining({ fund_id: 'f', vehicle_id: 'v-gpu', auto_post_payout_matches: true })])
    expect(await (await getSettings(req('/api/fleet/ops/settings?group=GPU%20I'))).json()).toEqual({ autoPostPayoutMatches: true })
  })

  it('refuses a non-boolean and a fund vehicle', async () => {
    expect((await patchSettings(req('/api/fleet/ops/settings', 'PATCH', { group: 'GPU I', autoPostPayoutMatches: 'yes' }))).status).toBe(400)
    expect((await getSettings(req('/api/fleet/ops/settings?group=Fund%20I'))).status).toBe(404)
  })
})

describe('default-metrics listings', () => {
  it('Settings and the Add-company form list company templates unless gpu_fleet is asked for', async () => {
    expect((await (await listDefaults(req('/api/default-metrics'))).json()).map((d: any) => d.slug)).toEqual(['mrr'])
    expect((await (await listDefaults(req('/api/default-metrics?holding_type=gpu_fleet'))).json()).map((d: any) => d.slug)).toEqual(['gpu-utilization'])
    expect((await listDefaults(req('/api/default-metrics?holding_type=crypto'))).status).toBe(400)
  })

  it('a company’s panel lists the templates of its own kind', async () => {
    const p = (id: string) => ({ params: Promise.resolve({ id }) })
    expect((await (await companyDefaults(req('/api/companies/vc/default-metrics'), p('vc'))).json()).map((d: any) => d.slug)).toEqual(['mrr'])
    expect((await (await companyDefaults(req('/api/companies/fleet/default-metrics'), p('fleet'))).json()).map((d: any) => d.slug)).toEqual(['gpu-utilization'])
  })
})
