import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import type { AccessContext } from '@/lib/access/effective'
import { GPU_SPV_CHART } from '@/lib/accounting/chart'
import { NO_CARRY } from '@/lib/accounting/carry'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * "Create pitch scenarios" (lib/gpu/scenario-seed.ts): six fleet plans from the model pack, Base case
 * primary and published as the approved baseline, every plan with a linked_fleet rule per flow; a
 * second call returns the same plans and creates nothing.
 */

vi.mock('@/lib/accounting/http-vehicle', async orig => ({
  ...(await orig<typeof import('@/lib/accounting/http-vehicle')>()),
  resolveVehicleWithAccess: async (_a: unknown, _acc: unknown, name: string) => ({ name, kind: 'gpu_spv' }),
}))
vi.mock('@/lib/accounting/vehicle-id', async orig => ({ ...(await orig<typeof import('@/lib/accounting/vehicle-id')>()), vehicleIdByName: async () => 'v1' }))
vi.mock('@/lib/accounting/periods', async orig => ({ ...(await orig<typeof import('@/lib/accounting/periods')>()), closedPeriodRanges: async () => [] }))
vi.mock('@/lib/accounting/currency', async orig => ({ ...(await orig<typeof import('@/lib/accounting/currency')>()), fundCurrency: async () => 'USD' }))
vi.mock('@/lib/accounting/load', async orig => ({ ...(await orig<typeof import('@/lib/accounting/load')>()), loadPostedLedger: async () => ({ postings: [], sourcedPostings: [] }) }))
vi.mock('@/lib/accounting/carry', async orig => ({ ...(await orig<typeof import('@/lib/accounting/carry')>()), loadCarryTerms: async () => NO_CARRY }))
vi.mock('@/lib/gpu/fee', async orig => ({ ...(await orig<typeof import('@/lib/gpu/fee')>()), loadFeeTerms: async () => null }))
vi.mock('@/lib/accounting/capital-source', async orig => ({ ...(await orig<typeof import('@/lib/accounting/capital-source')>()), loadCapitalPostings: async () => ({ postings: [] }) }))
vi.mock('@/lib/accounting/distributions', async orig => ({ ...(await orig<typeof import('@/lib/accounting/distributions')>()), loadContingencyByDate: async () => new Map() }))
vi.mock('@/lib/accounting/construction-service', () => ({
  getConstructionModel: async () => ({
    actuals: { uncalledCapital: 0 }, grossTimeline: null, timeline: null,
    forecast: { returns: {}, capital: {} }, assumptions: { simulation: { lossRate: 0, dispersion: 0, holdSpreadYears: 0 }, feeTermYears: 10, annualPartnershipExpense: 50_000, remainingOrgCosts: 0 },
    asOf: '2026-10-01T00:00:00Z',
  }),
  loadConstructionSeed: async () => null,
}))

import { createPitchScenarios, FLEET_FLOW_ACCOUNTS, PITCH_ORDER } from '@/lib/gpu/scenario-seed'
import { getVariance } from '@/lib/forecast/service'
import { FLEET_FLOWS } from '@/lib/forecast/rules'
import { PACK_SCENARIOS } from '@/lib/gpu/fixtures/pack-v3'

const FEATURES: FeatureVisibilityMap = { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', gp_economics: 'everyone' }
const ACCESS: AccessContext = { fundId: 'f1', userId: 'u1', role: 'member', vehicles: { all: true, ids: [] }, features: FEATURES, grants: { accounting: 'write' }, defaults: {} }

/** A memory database whose forecast_save / forecast_publish do what the SQL does to the rows these tests read. */
function books() {
  const { admin, tables } = memoryAdmin({
    chart_of_accounts: GPU_SPV_CHART.map(a => ({ id: `acct-${a.code}`, fund_id: 'f1', vehicle_id: 'v1', code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null, is_active: true })),
    forecast_plans: [], forecast_rules: [], forecast_overrides: [], forecast_versions: [], forecast_entries: [], gpu_asset_types: [], fund_vehicles: [], lp_entities: [],
  })
  let n = 0
  const rpc = vi.fn(async (name: string, args: any) => {
    const plan = tables.forecast_plans.find(p => p.id === args.p_plan_id)!
    if (name === 'forecast_save') {
      plan.status ??= 'active' // the column default
      for (const [k, v] of Object.entries(args.p_plan_patch ?? {})) plan[k] = v
      for (const r of args.p_rule_upserts) {
        tables.forecast_rules = tables.forecast_rules.filter(x => !(x.plan_id === plan.id && x.account_id === r.account_id))
        tables.forecast_rules.push({ ...r, fund_id: 'f1', plan_id: plan.id })
      }
      plan.revision += 1
      return { data: plan.revision, error: null }
    }
    if (name === 'forecast_publish') {
      const id = `ver${++n}`
      tables.forecast_versions.push({ id, fund_id: 'f1', plan_id: plan.id, version_no: 1, status: args.p_status, fleet: args.p_fleet ?? plan.fleet, start_month: plan.start_month, end_month: plan.end_month, published_at: '2026-10-19' })
      return { data: { id, versionNo: 1 }, error: null }
    }
    return { data: null, error: null }
  })
  return { admin: { from: (t: string) => (admin as any).from(t), rpc } as any, tables, rpc }
}
const ctx = (admin: any) => ({ admin, fundId: 'f1', userId: 'u1', access: ACCESS })

beforeEach(() => vi.clearAllMocks())

describe('createPitchScenarios', () => {
  it('creates the six pack scenarios, each with its fleet and a linked_fleet rule per flow', async () => {
    const b = books()
    const out = await createPitchScenarios(ctx(b.admin), 'GPU SPV I')
    expect(out.created).toBe(true)
    expect(out.plans.map(p => p.name).sort()).toEqual(PITCH_ORDER.map(id => PACK_SCENARIOS[id].label).sort())
    for (const p of b.tables.forecast_plans) {
      const id = PITCH_ORDER.find(k => PACK_SCENARIOS[k].label === p.name)!
      expect(p.scenario).toBe(p.name)
      expect(p.fleet.utilization).toBe(PACK_SCENARIOS[id].utilization)
      expect(p.fleet.types.b300.priceChanges).toEqual(PACK_SCENARIOS[id].priceChanges.b300)
      // Y1 is the plan's first month.
      expect(p.fleet.startMonth).toBe(String(p.start_month).slice(0, 7))
      const rules = b.tables.forecast_rules.filter(r => r.plan_id === p.id)
      expect(rules.map(r => r.params.flow).sort()).toEqual([...FLEET_FLOWS].sort())
      for (const r of rules) {
        expect(r.method).toBe('linked_fleet')
        expect(r.account_id).toBe(`acct-${FLEET_FLOW_ACCOUNTS[r.params.flow as keyof typeof FLEET_FLOW_ACCOUNTS]}`)
      }
    }
  })

  it('makes Base case the primary plan and publishes it as the approved baseline, freezing its fleet', async () => {
    const b = books()
    const out = await createPitchScenarios(ctx(b.admin), 'GPU SPV I')
    const base = b.tables.forecast_plans.find(p => p.name === 'Base case')!
    expect(b.tables.forecast_plans.filter(p => p.is_primary).map(p => p.id)).toEqual([base.id])
    expect(out.plans.find(p => p.isPrimary)?.name).toBe('Base case')
    const publish = b.rpc.mock.calls.filter(c => c[0] === 'forecast_publish')
    expect(publish).toHaveLength(1)
    expect(publish[0][1]).toMatchObject({ p_plan_id: base.id, p_status: 'approved', p_fleet: base.fleet })
    expect(out.baseVersionId).toBe(b.tables.forecast_versions[0].id)
  })

  it('variance runs against the Base version by default', async () => {
    const b = books()
    await createPitchScenarios(ctx(b.admin), 'GPU SPV I')
    const base = b.tables.forecast_plans.find(p => p.name === 'Base case')!
    const v = await getVariance(ctx(b.admin), { vehicle: 'GPU SPV I', base: { planId: base.id }, compare: 'actual', start: base.fleet.startMonth, end: base.fleet.startMonth })
    expect(v.base.version?.id).toBe(b.tables.forecast_versions[0].id)
    expect(v.base.version?.status).toBe('approved')
  })

  it('is idempotent: a second call returns the same plans and creates nothing', async () => {
    const b = books()
    const first = await createPitchScenarios(ctx(b.admin), 'GPU SPV I')
    const writes = b.rpc.mock.calls.length
    const second = await createPitchScenarios(ctx(b.admin), 'GPU SPV I')
    expect(second.created).toBe(false)
    expect(second.plans).toEqual(first.plans)
    expect(b.tables.forecast_plans).toHaveLength(6)
    expect(b.rpc.mock.calls.length).toBe(writes)
  })

  it('gives a GPU SPV plan no fund-style fee or expense rules from construction terms', async () => {
    const b = books()
    await createPitchScenarios(ctx(b.admin), 'GPU SPV I')
    expect(b.tables.forecast_rules.every(r => r.method === 'linked_fleet')).toBe(true)
  })
})
