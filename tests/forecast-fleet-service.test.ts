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
const feeTerms = vi.hoisted(() => ({ current: null as any }))
vi.mock('@/lib/gpu/fee', async orig => ({ ...(await orig<typeof import('@/lib/gpu/fee')>()), loadFeeTerms: async () => feeTerms.current }))
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

import { createPlan, getFleetReport, getPlan, getPlanReturns, publishPlan, savePlan, ForecastError } from '@/lib/forecast/service'
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
  const inserted: any[] = []
  const { admin, tables } = memoryAdmin({
    chart_of_accounts: GPU_SPV_CHART.map(a => ({ id: `acct-${a.code}`, fund_id: 'f1', vehicle_id: 'v1', code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null, is_active: true })),
    forecast_plans: plans,
    forecast_rules: withRules ? FLEET_FLOWS.map(flow => ({
      id: `r-${flow}`, fund_id: 'f1', plan_id: 'p1', account_id: `acct-${FLOW_CODE[flow]}`, method: 'linked_fleet', params: { flow },
      cash_timing: { mode: 'same' }, source: 'seeded', note: null,
    })) : [],
    forecast_overrides: [], forecast_versions: [], forecast_entries: [], gpu_asset_types: [], fund_vehicles: [], lp_entities: [],
  }, { before: (table, op, payload) => { if (table === 'forecast_plans' && op === 'insert') inserted.push(...[payload].flat()) } })
  const rpc = vi.fn(async (name: string, _args: any) => ({ data: name === 'forecast_publish' ? { id: 'ver1', versionNo: 1 } : null, error: null }))
  return { admin: { from: (t: string) => (admin as any).from(t), rpc } as any, tables, rpc, inserted }
}
const ctx = (admin: any, a: AccessContext = WRITER) => ({ admin, fundId: 'f1', userId: 'u1', access: a })
const statusOf = async (p: Promise<unknown>) => { try { await p; return 200 } catch (e) { if (e instanceof ForecastError) return e.status; throw e } }

beforeEach(() => { vi.clearAllMocks(); feeTerms.current = null })

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
  it('hands the plan’s fleet to forecast_publish as p_fleet, with the terms it ran on frozen in', async () => {
    const b = books([plan()])
    await publishPlan(ctx(b.admin), { vehicle: GPU, planId: 'p1', expectedRevision: 3, status: 'published' })
    const [name, args] = b.rpc.mock.calls.find(c => c[0] === 'forecast_publish')!
    expect(name).toBe('forecast_publish')
    // The vehicle has no terms of its own here, so the pack's: 5% fee, 8% pref, 30% split, 100% ROC.
    expect(args.p_fleet).toEqual({ ...FLEET, overrides: { feeRate: 0.05, prefRate: 0.08, carryRate: 0.3, rocLpShare: 1 } })
    // The frozen entries are the fleet compile: revenue on 4000 in the first plan month.
    expect(args.p_entries.some((e: any) => e.account_id === 'acct-4000' && e.entry_date.startsWith(firstPlanMonth))).toBe(true)
  })

  it('a register plan freezes the servers it ran on, and the version runs from its fleet alone', async () => {
    const b = books([plan({ fleet: { ...FLEET, assets: 'register' } })])
    b.tables.gpu_asset_types.push({ id: 't1', fund_id: 'f1', code: 'b200', label: 'B200', gpu_model: null, gpus_per_server: 8, anchor_rate: null, notes: null })
    const assets = await import('@/lib/gpu/assets')
    const list = vi.spyOn(assets, 'listAssets').mockResolvedValue([{ id: 'a1', name: 'srv-1', status: 'in_service', asset_type_id: 't1', hardware_cost: 410_000, capitalized_costs: 0 } as any])
    feeTerms.current = { basis: 'gross_revenue', annualRate: 0.05, revenueSubtypes: ['rental_revenue'], frequency: 'monthly', payeeVehicleId: null }
    await publishPlan(ctx(b.admin), { vehicle: GPU, planId: 'p1', expectedRevision: 3, status: 'approved' })
    const frozen = b.rpc.mock.calls.find(c => c[0] === 'forecast_publish')![1].p_fleet
    expect(frozen.assets).toEqual([{ typeCode: 'b200', servers: 1, gpusPerServer: 8, hardwareCost: 410_000, capitalizedCosts: 0 }])
    expect(frozen.overrides.feeRate).toBe(0.05)
    b.tables.forecast_versions.push({ id: 'ver1', fund_id: 'f1', plan_id: 'p1', fleet: frozen })
    const before = await getFleetReport(ctx(b.admin), { vehicle: GPU, planId: 'p1', versionId: 'ver1' })
    // After publishing: the fee is cut and the register empties. The version's sheets do not move.
    feeTerms.current = { ...feeTerms.current, annualRate: 0.02 }
    list.mockResolvedValue([])
    const after = await getFleetReport(ctx(b.admin), { vehicle: GPU, planId: 'p1', versionId: 'ver1' })
    expect(after).toEqual(before)
    expect(Math.round(after!.detail.waterfall.rows.find(r => r.key === 'fee')!.total!)).toBeGreaterThan(0)
    // The draft moves with them: an empty register is nothing to show.
    expect(await getFleetReport(ctx(b.admin), { vehicle: GPU, planId: 'p1' })).toBeNull()
    list.mockRestore()
  })

  it('a plan without a fleet publishes p_fleet null', async () => {
    const b = books([plan({ fleet: null })], false)
    await publishPlan(ctx(b.admin), { vehicle: GPU, planId: 'p1', expectedRevision: 3, status: 'published' })
    expect(b.rpc.mock.calls.find(c => c[0] === 'forecast_publish')![1].p_fleet).toBeNull()
  })
})

describe("a pitch plan's opening: the capital raised and the fleet bought", () => {
  const balances = (entries: { postings: { accountId: string; amount: number }[] }[]) => {
    const out = new Map<string, number>()
    for (const e of entries) for (const p of e.postings) out.set(p.accountId, Math.round(((out.get(p.accountId) ?? 0) + p.amount) * 100) / 100)
    return (code: string) => out.get(`acct-${code}`) ?? 0
  }

  it('funds cash and equity, and the sale clears 1600 and 1650 to zero', async () => {
    const detail = await getPlan(ctx(books([plan()]).admin), { vehicle: GPU, planId: 'p1' })
    const raise = detail.entries.find(e => e.memo === 'Capital raised for the fleet')!
    expect(raise).toMatchObject({ kind: 'capital_call', date: `${firstPlanMonth}-${raise.date.slice(8)}` })
    expect(raise.postings).toEqual([{ accountId: 'acct-1000', amount: 1_435_500 }, { accountId: 'acct-3100', amount: -1_435_500 }])
    const bought = detail.entries.filter(e => e.kind === 'investment')
    expect(bought.map(e => e.postings.find(p => p.accountId !== 'acct-1000')!)).toEqual([
      { accountId: 'acct-1600', amount: 1_305_000 },
      // The pack: the whole 10% contingency consumed, nothing capitalized or returned.
      { accountId: 'acct-5900', amount: 130_500 },
    ])
    const bal = balances(detail.entries)
    expect(bal('1600')).toBe(0)
    expect(bal('1650')).toBe(0)
    // Net book value through the plan: at each plan year's end, 1600 − 1650 is the engine's NBV.
    const engine = runFleetScenario(FLEET, PACK_FLEET, PACK_SCENARIO_TERMS)
    const fleetMonth = (k: number) => { const [y, mm] = firstPlanMonth.split('-').map(Number); const t = y * 12 + mm - 1 + k; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}` }
    for (const y of [1, 2, 3, 4]) {
      const end = fleetMonth(12 * y - 1)
      const nbv = balances(detail.entries.filter(e => e.date.slice(0, 7) <= end))
      expect(Math.round((nbv('1600') + nbv('1650')) * 100), `Y${y}`).toBe(Math.round(engine.operating[y].nbv * 100))
    }
    // The raise pays for the fleet and the contingency exactly: the opening nets to no cash.
    const opening = [raise, ...bought].flatMap(e => e.postings).filter(p => p.accountId === 'acct-1000').reduce((s, p) => s + p.amount, 0)
    expect(opening).toBe(0)
  })

  it('a register plan carries these from the books, so it books none of them', async () => {
    const b = books([plan({ fleet: { ...FLEET, assets: 'register' } })])
    b.tables.gpu_asset_types.push({ id: 't1', fund_id: 'f1', code: 'b200', label: 'B200', gpu_model: null, gpus_per_server: 8, anchor_rate: null, notes: null })
    const assets = await import('@/lib/gpu/assets')
    const list = vi.spyOn(assets, 'listAssets').mockResolvedValue([{ id: 'a1', name: 'srv-1', status: 'in_service', asset_type_id: 't1', hardware_cost: 410_000, capitalized_costs: 0 } as any])
    const detail = await getPlan(ctx(b.admin), { vehicle: GPU, planId: 'p1' })
    expect(detail.entries.some(e => e.memo === 'Capital raised for the fleet' || e.kind === 'investment')).toBe(false)
    expect(detail.entries.some(e => e.accountId === 'acct-4000')).toBe(true)
    list.mockRestore()
  })
})

describe('R8 in the monthly plan: the unspent contingency is paid out in its return year', () => {
  it('Oversupply 50% with 100,000 spent: 30,500 released in Y5, as the engine pays it', async () => {
    const fleet = packAssumptions('oversupply_50', { startMonth: firstPlanMonth as any, capex: { contingencyPct: 0.1, contingencySpent: 100_000 } })
    const consumedAll = packAssumptions('oversupply_50', { startMonth: firstPlanMonth as any })
    const engine = runFleetScenario(fleet, PACK_FLEET, PACK_SCENARIO_TERMS)
    expect(engine.waterfall[4].contingencyReturn).toBe(30_500)
    const r = await getPlanReturns(ctx(books([plan({ fleet })]).admin), { vehicle: GPU, planId: 'p1' })
    const pack = await getPlanReturns(ctx(books([plan({ fleet: consumedAll })]).admin), { vehicle: GPU, planId: 'p1' })
    // Only 100,000 of the 130,500 is spent, so 30,500 more is paid out, in Y5's first month.
    const y5 = Number(firstPlanMonth.slice(0, 4)) + 4
    const paid = (x: typeof r) => x.base.distributedToDate[x.base.distributedToDate.length - 1]
    expect(Math.round((paid(r) - paid(pack)) * 100)).toBe(3_050_000)
    expect(r.base.years.find(y => y.calendarYear === y5)!.distributed).toBeGreaterThan(pack.base.years.find(y => y.calendarYear === y5)!.distributed)
    expect(r.base.totals.carry).toBe(0)
    // And the opening books only the 100,000 consumed.
    const detail = await getPlan(ctx(books([plan({ fleet })]).admin), { vehicle: GPU, planId: 'p1' })
    expect(detail.entries.find(e => e.accountId === 'acct-5900' && e.kind === 'investment')!.postings[0].amount).toBe(100_000)
  })
})

describe('copying a fleet plan', () => {
  it('carries its fleet with its capital and hand edits', async () => {
    const b = books([plan({ capital: { policy: { calls: { reserve: 7 } } } })])
    await createPlan(ctx(b.admin), { vehicle: GPU, kind: 'rolling_forecast', name: 'Copy', seed: { from: 'plan', planId: 'p1' } }).catch(() => null)
    const copy = b.tables.forecast_plans.find(p => p.name === 'Copy') ?? null
    const inserted = copy ?? b.inserted.find((r: any) => r.name === 'Copy')
    expect(inserted.fleet).toEqual(FLEET)
    expect(inserted.capital).toEqual({ policy: { calls: { reserve: 7 } } })
    // The copy compiles the fleet's flows like its source: rental revenue from the first plan month.
    const save = b.rpc.mock.calls.find(c => c[0] === 'forecast_save' && c[1].p_plan_id === inserted.id)!
    expect(save[1].p_rule_upserts.every((r: any) => r.method === 'linked_fleet')).toBe(true)
    expect(save[1].p_entries.some((e: any) => e.account_id === 'acct-4000' && e.entry_date.startsWith(firstPlanMonth))).toBe(true)
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
