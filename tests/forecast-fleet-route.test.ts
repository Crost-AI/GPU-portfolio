import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import type { AccessContext } from '@/lib/access/effective'
import { GPU_SPV_CHART } from '@/lib/accounting/chart'
import { NO_CARRY } from '@/lib/accounting/carry'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * GET/POST /api/accounting/forecast/fleet-scenarios (the gpu-P5 contract): a vehicle that is not a
 * GPU SPV is refused with a 404 before anything is read, the raw scenario results are redacted for
 * a member without gp_economics, and `results` is empty when there are no fleet plans.
 */

const FEATURES: FeatureVisibilityMap = { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', gp_economics: 'everyone' }
const access = (grants: AccessContext['grants']): AccessContext => ({
  fundId: 'f1', userId: 'u1', role: 'member', vehicles: { all: true, ids: [] }, features: FEATURES, grants, defaults: {},
})

const mocks = vi.hoisted(() => ({
  admin: null as any,
  access: null as any,
  seed: vi.fn(),
  group: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => mocks.admin }))
vi.mock('@/lib/api-helpers', () => ({
  assertReadAccess: async () => ({ fundId: 'f1', userId: 'u1', role: 'member', need: 'read' }),
  assertWriteAccess: async () => ({ fundId: 'f1', userId: 'u1', role: 'member', need: 'write' }),
}))
vi.mock('@/lib/access/effective', async orig => ({ ...(await orig<typeof import('@/lib/access/effective')>()), loadAccessContext: async () => mocks.access }))
vi.mock('@/lib/accounting/http-vehicle', async orig => ({
  ...(await orig<typeof import('@/lib/accounting/http-vehicle')>()),
  resolveGroupOr400: async (_a: unknown, _g: unknown, name: string | null) => mocks.group(name) ?? name,
  resolveVehicleWithAccess: async (_a: unknown, _acc: unknown, name: string) => ({ name, kind: name === 'GPU SPV I' ? 'gpu_spv' : 'fund' }),
}))
vi.mock('@/lib/accounting/vehicle-id', async orig => ({ ...(await orig<typeof import('@/lib/accounting/vehicle-id')>()), vehicleIdByName: async () => 'v1' }))
vi.mock('@/lib/accounting/carry', async orig => ({ ...(await orig<typeof import('@/lib/accounting/carry')>()), loadCarryTerms: async () => NO_CARRY }))
vi.mock('@/lib/gpu/fee', async orig => ({ ...(await orig<typeof import('@/lib/gpu/fee')>()), loadFeeTerms: async () => null }))
vi.mock('@/lib/gpu/scenario-seed', async orig => ({ ...(await orig<typeof import('@/lib/gpu/scenario-seed')>()), createPitchScenarios: mocks.seed }))

import { GET, POST } from '@/app/api/accounting/forecast/fleet-scenarios/route'
import { packAssumptions } from '@/lib/gpu/fixtures/pack-v3-fleet'

const planRow = (id: string, name: string, fleet: unknown, isPrimary = false) => ({
  id, fund_id: 'f1', vehicle_id: 'v1', kind: 'rolling_forecast', name, scenario: name, fiscal_year: null, start_month: '2027-01-01', end_month: '2031-12-01',
  horizon_months: 60, actuals_cutoff: null, opening_settlement_months: 1, include_construction: true, adjustments: null, construction: null, capital: {},
  fleet, is_primary: isPrimary, status: 'active', revision: 1, compiled_at: null, compiled_cutoff: null, compiled_closed_through: null,
  created_at: `2026-10-0${id === 'base' ? 1 : 2}`, updated_at: '2026-10-01',
})

function setup(plans: Record<string, unknown>[], grants: AccessContext['grants']) {
  mocks.admin = memoryAdmin({
    fund_vehicles: [{ id: 'v1', fund_id: 'f1', name: 'GPU SPV I', kind: 'gpu_spv' }, { id: 'v2', fund_id: 'f1', name: 'Fund I', kind: 'fund' }],
    chart_of_accounts: GPU_SPV_CHART.map(a => ({ id: `acct-${a.code}`, fund_id: 'f1', vehicle_id: 'v1', code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null, is_active: true })),
    forecast_plans: plans, accounting_periods: [], gpu_asset_types: [],
  }).admin
  mocks.access = access(grants)
}
const PLANS = [
  planRow('base', 'Base case', packAssumptions('base', { cadence: 'quarterly' }), true),
  planRow('over', 'Oversupply', packAssumptions('oversupply', { cadence: 'quarterly' })),
  planRow('vc', 'Budget', null),
]
const get = (group: string, plan?: string) => GET(new NextRequest(`http://x/api/accounting/forecast/fleet-scenarios?group=${encodeURIComponent(group)}${plan ? `&plan=${plan}` : ''}`))
const post = (body: unknown) => POST(new NextRequest('http://x/api/accounting/forecast/fleet-scenarios', { method: 'POST', body: JSON.stringify(body) }))

beforeEach(() => { vi.clearAllMocks(); mocks.group.mockReturnValue(undefined) })

describe('GET fleet-scenarios', () => {
  it('runs every fleet plan, Base primary, with the comparison and the primary detail', async () => {
    setup(PLANS, { accounting: 'read', gp_economics: 'read' })
    const res = await get('GPU SPV I')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Object.keys(body.results)).toEqual(['base', 'over'])
    expect(body.primaryPlanId).toBe('base')
    expect(body.cadence).toBe('quarterly')
    expect(body.comparison.headline.columns).toEqual(['base', 'over'])
    expect(body.plans.map((p: any) => p.name)).toEqual(['Base case', 'Oversupply'])
    expect(Math.round(body.results.base.returns.managerTotal)).toBe(770_088)
    expect(body.detail.waterfall.rows.find((r: any) => r.key === 'carry').redacted).toBe(false)
    const over = await (await get('GPU SPV I', 'over')).json()
    expect(Math.round(over.detail.waterfall.rows.find((r: any) => r.key === 'carry').total)).toBe(170_106)
  })

  it('nulls every manager figure for a member without gp_economics, raw results included', async () => {
    setup(PLANS, { accounting: 'read' })
    const body = await (await get('GPU SPV I')).json()
    for (const r of Object.values<any>(body.results)) {
      expect(r.returns.managerCarry).toBeNull()
      expect(r.returns.managerTotal).toBeNull()
      expect(r.waterfall.every((w: any) => w.carry === null && w.toManager === null && w.managerRocShare === null)).toBe(true)
      for (const b of Object.values<any>(r.returns.byCadence)) expect(b.periods.every((p: any) => p.carry === null && p.toManager === null)).toBe(true)
      // The fee is an SPV expense and stays.
      expect(r.returns.managerFees).toBeGreaterThan(0)
    }
    const share = body.comparison.headline.rows.find((r: any) => r.key === 'managerProfitShare')
    expect(share).toMatchObject({ redacted: true, total: null })
    expect(share.values.every((v: unknown) => v === null)).toBe(true)
    expect(body.detail.waterfall.rows.find((r: any) => r.key === 'carry')).toMatchObject({ redacted: true, total: null })
    expect(JSON.stringify(body)).not.toContain('549823')
  })

  it('answers results {} when the vehicle has no fleet plans', async () => {
    setup([planRow('vc', 'Budget', null)], { accounting: 'read' })
    const body = await (await get('GPU SPV I')).json()
    expect(body).toMatchObject({ results: {}, detail: null, cadence: null, primaryPlanId: null, plans: [] })
  })

  it('refuses a vehicle that is not a GPU SPV with a 404 before reading its plans', async () => {
    setup(PLANS, { accounting: 'write', gp_economics: 'read' })
    const res = await get('Fund I')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Vehicle not found' })
  })

  it('404s a plan that is not one of the fleet plans', async () => {
    setup(PLANS, { accounting: 'read' })
    expect((await get('GPU SPV I', 'vc')).status).toBe(404)
  })
})

describe('POST fleet-scenarios', () => {
  it('seeds on a GPU SPV and answers 200, created or not', async () => {
    setup(PLANS, { accounting: 'write' })
    mocks.seed.mockResolvedValue({ created: false, plans: [{ id: 'base', name: 'Base case', scenario: 'Base case', isPrimary: true }], baseVersionId: null })
    const res = await post({ group: 'GPU SPV I', action: 'seed' })
    expect(res.status).toBe(200)
    expect((await res.json()).created).toBe(false)
    expect(mocks.seed.mock.calls[0][1]).toBe('GPU SPV I')
  })

  it('refuses a vehicle that is not a GPU SPV, and an unknown action', async () => {
    setup(PLANS, { accounting: 'write' })
    expect((await post({ group: 'Fund I', action: 'seed' })).status).toBe(404)
    expect((await post({ group: 'GPU SPV I', action: 'delete' })).status).toBe(400)
    expect(mocks.seed).not.toHaveBeenCalled()
  })
})
