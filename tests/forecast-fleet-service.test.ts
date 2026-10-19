import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import type { AccessContext } from '@/lib/access/effective'
import { GPU_SPV_CHART } from '@/lib/accounting/chart'
import { NO_CARRY } from '@/lib/accounting/carry'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * The forecast service on a GPU SPV plan (gpu-P4 B1): the plan PATCH takes and checks `fleet`,
 * a published version freezes it (forecast_publish's p_fleet), and the plan's returns split its
 * distributions with the distributable-cash waterfall.
 */

const GPU = 'GPU SPV I'
vi.mock('@/lib/accounting/http-vehicle', async orig => ({
  ...(await orig<typeof import('@/lib/accounting/http-vehicle')>()),
  resolveVehicleWithAccess: async (_a: unknown, _acc: unknown, name: string) => ({ name, kind: name === GPU ? 'gpu_spv' : 'fund' }),
}))
vi.mock('@/lib/accounting/vehicle-id', async orig => ({
  ...(await orig<typeof import('@/lib/accounting/vehicle-id')>()),
  vehicleIdByName: async () => 'v1',
}))
vi.mock('@/lib/accounting/periods', async orig => ({ ...(await orig<typeof import('@/lib/accounting/periods')>()), closedPeriodRanges: async () => [] }))
vi.mock('@/lib/accounting/currency', async orig => ({ ...(await orig<typeof import('@/lib/accounting/currency')>()), fundCurrency: async () => 'USD' }))
vi.mock('@/lib/accounting/load', async orig => ({ ...(await orig<typeof import('@/lib/accounting/load')>()), loadPostedLedger: async () => ({ postings: [] }) }))
vi.mock('@/lib/accounting/carry', async orig => ({ ...(await orig<typeof import('@/lib/accounting/carry')>()), loadCarryTerms: async () => NO_CARRY }))
vi.mock('@/lib/gpu/fee', async orig => ({ ...(await orig<typeof import('@/lib/gpu/fee')>()), loadFeeTerms: async () => null }))
vi.mock('@/lib/accounting/capital-source', async orig => ({ ...(await orig<typeof import('@/lib/accounting/capital-source')>()), loadCapitalPostings: async () => ({ postings: [] }) }))
vi.mock('@/lib/accounting/distributions', async orig => ({ ...(await orig<typeof import('@/lib/accounting/distributions')>()), loadContingencyByDate: async () => new Map() }))
vi.mock('@/lib/accounting/construction-service', () => ({
  getConstructionModel: async () => ({
    actuals: { uncalledCapital: 0 }, grossTimeline: null, timeline: null,
    forecast: { returns: {}, capital: {} }, assumptions: { simulation: { lossRate: 0, dispersion: 0, holdSpreadYears: 0 } },
    asOf: '2026-10-01T00:00:00Z',
  }),
  loadConstructionSeed: async () => null,
}))

import { getPlan, getPlanReturns, publishPlan, savePlan, ForecastError } from '@/lib/forecast/service'
import { PACK_FLEET, PACK_SCENARIO_TERMS, packAssumptions } from '@/lib/gpu/fixtures/pack-v3-fleet'
import { runFleetScenario } from '@/lib/gpu/scenario'
import { F1 } from '@/lib/gpu/fixtures/pack-v3'
import { FLEET_FLOWS } from '@/lib/forecast/rules'

const FEATURES: FeatureVisibilityMap = { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', gp_economics: 'everyone' }
const access = (grants: AccessContext['grants']): AccessContext => ({
  fundId: 'f1', userId: 'u1', role: 'member', vehicles: { all: true, ids: [] }, features: FEATURES, grants, defaults: {},
})
const WRITER = access({ accounting: 'write', gp_economics: 'read' })
const NO_GP = access({ accounting: 'write' })

const FLOW_CODE = { revenue: '4000', processing_fee: '5150', datacenter: '5100', contingency: '5900', insurance: '5200', depreciation: '5300', disposal: '4500', fee: '5000' } as const
// A pitch on a vehicle with no books: nothing is closed, so the cutoff is last month and the plan opens this month.
const thisMonth = new Date().toISOString().slice(0, 7)
const firstPlanMonth = thisMonth // rolling forecast: cutoff = last month, so the plan opens this month
const FLEET = packAssumptions('base', { startMonth: firstPlanMonth as any })

const plan = (over: Record<string, unknown> = {}) => ({
  id: 'p1', fund_id: 'f1', vehicle_id: 'v1', kind: 'rolling_forecast', name: 'Base case', scenario: 'Base case', fiscal_year: null,
  start_month: `${thisMonth}-01`, end_month: `${thisMonth}-01`, horizon_months: 60, actuals_cutoff: null,
  opening_settlement_months: 1, include_construction: true, adjustments: null, construction: null,
  capital: {}, fleet: FLEET, is_primary: true, status: 'active', revision: 3,
  compiled_at: null, compiled_cutoff: null, compiled_closed_through: null, created_at: '2026-01-01', updated_at: '2026-01-01',
  ...over,
})

function books(plans: Record<string, unknown>[], withRules = true) {
  const { admin, tables } = memoryAdmin({
    chart_of_accounts: GPU_SPV_CHART.map(a => ({ id: `acct-${a.code}`, fund_id: 'f1', vehicle_id: 'v1', code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null, is_active: true })),
    forecast_plans: plans,
    forecast_rules: withRules ? FLEET_FLOWS.map(flow => ({
      id: `r-${flow}`, fund_id: 'f1', plan_id: 'p1', account_id: `acct-${FLOW_CODE[flow]}`, method: 'linked_fleet', params: { flow },
      cash_timing: { mode: 'same' }, source: 'seeded', note: null,
    })) : [],
    forecast_overrides: [], forecast_versions: [], forecast_entries: [], gpu_asset_types: [], fund_vehicles: [], lp_entities: [],
  })
  const rpc = vi.fn(async (name: string, _args: any) => ({ data: name === 'forecast_publish' ? { id: 'ver1', versionNo: 1 } : null, error: null }))
  return { admin: { from: (t: string) => (admin as any).from(t), rpc } as any, tables, rpc }
}
const ctx = (admin: any, a: AccessContext = WRITER) => ({ admin, fundId: 'f1', userId: 'u1', access: a })
const statusOf = async (p: Promise<unknown>) => { try { await p; return 200 } catch (e) { if (e instanceof ForecastError) return e.status; throw e } }

beforeEach(() => vi.clearAllMocks())

describe('plan PATCH: fleet', () => {
  it('stores the checked assumptions through forecast_save, and GET returns them', async () => {
    const b = books([plan({ fleet: null })])
    const fleet = { ...FLEET, junk: 'dropped' }
    await savePlan(ctx(b.admin), { vehicle: GPU, planId: 'p1', expectedRevision: 3, fleet })
    const save = b.rpc.mock.calls.find(c => c[0] === 'forecast_save')!
    expect(save[1].p_plan_patch.fleet).toEqual(FLEET)
    // The rpc is a spy, so GET reads a stored plan.
    const detail = await getPlan(ctx(books([plan()]).admin), { vehicle: GPU, planId: 'p1' })
    expect(detail.plan.fleet).toEqual(FLEET)
    expect(detail.rules.find(r => r.method === 'linked_fleet' && (r.params as any).flow === 'revenue')!.basis).toMatch(/^Fleet scenario rental revenue/)
  })

  it('refuses bad assumptions as a 400 naming the field, and fleet on a vehicle that is not a GPU SPV', async () => {
    const b = books([plan()])
    await expect(savePlan(ctx(b.admin), { vehicle: GPU, planId: 'p1', expectedRevision: 3, fleet: { ...FLEET, saleYear: 9 } })).rejects.toThrow(/fleet\.saleYear/)
    expect(await statusOf(savePlan(ctx(b.admin), { vehicle: GPU, planId: 'p1', expectedRevision: 3, fleet: { ...FLEET, types: {} } }))).toBe(400)
    expect(await statusOf(savePlan(ctx(b.admin), { vehicle: 'Fund I', planId: 'p1', expectedRevision: 3, fleet: FLEET }))).toBe(400)
    expect(b.rpc).not.toHaveBeenCalled()
  })

  it('null removes the fleet', async () => {
    const b = books([plan()], false)
    await savePlan(ctx(b.admin), { vehicle: GPU, planId: 'p1', expectedRevision: 3, fleet: null })
    expect(b.rpc.mock.calls[0][1].p_plan_patch).toMatchObject({ fleet: null })
  })
})

describe('publishing freezes the fleet', () => {
  it('hands the plan’s fleet to forecast_publish as p_fleet', async () => {
    const b = books([plan()])
    await publishPlan(ctx(b.admin), { vehicle: GPU, planId: 'p1', expectedRevision: 3, status: 'published' })
    const [name, args] = b.rpc.mock.calls.find(c => c[0] === 'forecast_publish')!
    expect(name).toBe('forecast_publish')
    expect(args.p_fleet).toEqual(FLEET)
    // The frozen entries are the fleet compile: revenue on 4000 in the first plan month.
    expect(args.p_entries.some((e: any) => e.account_id === 'acct-4000' && e.entry_date.startsWith(firstPlanMonth))).toBe(true)
  })

  it('a plan without a fleet publishes p_fleet null', async () => {
    const b = books([plan({ fleet: null })], false)
    await publishPlan(ctx(b.admin), { vehicle: GPU, planId: 'p1', expectedRevision: 3, status: 'published' })
    expect(b.rpc.mock.calls.find(c => c[0] === 'forecast_publish')![1].p_fleet).toBeNull()
  })
})

describe("a GPU SPV plan's returns", () => {
  it('distributes the operating cash and splits it with the distributable-cash waterfall', async () => {
    const b = books([plan()])
    const r = await getPlanReturns(ctx(b.admin), { vehicle: GPU, planId: 'p1' })
    // Pitch: 1,435,500 assumed in the month before Y1; operating cash and the sale paid out monthly.
    // Everything the engine makes distributable reaches the investors' side: paid out, or — the
    // sale month's revenue, received the month after the plan ends — valued at the end.
    // Exactly the compiled flows, each the engine's figure for its year in cents ...
    const engine = runFleetScenario(FLEET, PACK_FLEET, PACK_SCENARIO_TERMS)
    const c = (n: number) => Math.round(n * 100)
    const flows = engine.operating.slice(1).reduce((s, o, k) =>
      s + c(o.revenue) - c(o.datacenter) - c(o.contingency) - c(o.processing) - c(o.insurance) - c(engine.waterfall[k].fee) + c(o.saleProceeds), 0)
    expect(Math.round((r.base.totals.distributed + r.base.lp.terminal) * 100)).toBe(flows)
    // ... which is the engine's distributable (3,456,399.99) to within the cents each flow rounds to.
    const distributable = F1.distributableCents.reduce((s, d) => s + c(d), 0)
    expect(distributable).toBe(345_639_999)
    expect(Math.abs(flows - distributable)).toBeLessThanOrEqual(5)
    // The receivable left at the end is one month of Y5 revenue (793,063.60 / 12, in cents).
    expect(r.base.lp.terminal).toBe(66_088.63)
    // Monthly distributions return capital sooner than the pack's annual ones, so less pref accrues and
    // more reaches the split: the plan's profit share is its own, not the pack's 549,824.
    expect(r.base.totals.carry).toBe(543_895)
    expect(F1.totals.carry - r.base.totals.carry).toBeGreaterThan(5_000)
    expect(r.carryRestricted).toBe(false)
  })

  it('without gp_economics the profit share is left out', async () => {
    const b = books([plan()])
    const r = await getPlanReturns(ctx(b.admin, NO_GP), { vehicle: GPU, planId: 'p1' })
    expect(r.base.totals.carry).toBe(0)
    expect(r.carryRestricted).toBe(true)
  })
})
