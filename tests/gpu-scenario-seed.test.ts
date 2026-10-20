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
function books(failRulesSaveOf: string | null = null, failPublishOnce = false) {
  let failing = failRulesSaveOf
  let failPublish = failPublishOnce
  const written = new Set<string>()
  const { admin, tables } = memoryAdmin({
    chart_of_accounts: GPU_SPV_CHART.map(a => ({ id: `acct-${a.code}`, fund_id: 'f1', vehicle_id: 'v1', code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null, is_active: true })),
    forecast_plans: [], forecast_rules: [], forecast_overrides: [], forecast_versions: [], forecast_entries: [], gpu_asset_types: [], fund_vehicles: [], lp_entities: [],
  }, { before: table => { written.add(table) } })
  let n = 0
  const rpc = vi.fn(async (name: string, args: any) => {
    const plan = tables.forecast_plans.find(p => p.id === args.p_plan_id)!
    if (name === 'forecast_save') {
      plan.status ??= 'active' // the column default
      if (failing && plan.name === failing && args.p_rule_upserts.length) { failing = null; return { data: null, error: { message: 'connection reset' } } }
      for (const [k, v] of Object.entries(args.p_plan_patch ?? {})) plan[k] = v
      for (const r of args.p_rule_upserts) {
        tables.forecast_rules = tables.forecast_rules.filter(x => !(x.plan_id === plan.id && x.account_id === r.account_id))
        tables.forecast_rules.push({ ...r, fund_id: 'f1', plan_id: plan.id })
      }
      plan.revision += 1
      return { data: plan.revision, error: null }
    }
    if (name === 'forecast_publish') {
      if (failPublish) { failPublish = false; return { data: null, error: { message: 'connection reset' } } }
      const id = `ver${++n}`
      tables.forecast_versions.push({ id, fund_id: 'f1', plan_id: plan.id, version_no: 1, status: args.p_status, fleet: args.p_fleet ?? plan.fleet, start_month: plan.start_month, end_month: plan.end_month, published_at: '2026-10-19' })
      return { data: { id, versionNo: 1 }, error: null }
    }
    return { data: null, error: null }
  })
  return { admin: { from: (t: string) => (admin as any).from(t), rpc } as any, tables, rpc, written }
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

  const flowsOf = (b: ReturnType<typeof books>, name: string) => {
    const p = b.tables.forecast_plans.find(x => x.name === name)!
    return b.tables.forecast_rules.filter(r => r.plan_id === p.id && r.method === 'linked_fleet').map(r => r.params.flow).sort()
  }

  it("a failed rule save (Balanced): the next run saves that plan's rules and creates the rest, none twice", async () => {
    const b = books('Balanced')
    await expect(createPitchScenarios(ctx(b.admin), 'GPU SPV I')).rejects.toBeTruthy()
    // Base case done; Balanced inserted with its fleet but its rules never saved.
    expect(b.tables.forecast_plans.map(p => p.name)).toEqual(['Base case', 'Balanced'])
    expect(flowsOf(b, 'Balanced')).toEqual([])
    const again = await createPitchScenarios(ctx(b.admin), 'GPU SPV I')
    expect(again.created).toBe(true)
    expect(b.tables.forecast_plans.map(p => p.name).sort()).toEqual(PITCH_ORDER.map(id => PACK_SCENARIOS[id].label).sort())
    for (const id of PITCH_ORDER) expect(flowsOf(b, PACK_SCENARIOS[id].label), id).toEqual([...FLEET_FLOWS].sort())
    // Base was published once, by the first run.
    expect(b.rpc.mock.calls.filter(c => c[0] === 'forecast_publish')).toHaveLength(1)
    expect(again.baseVersionId).toBeNull()
    expect((await createPitchScenarios(ctx(b.admin), 'GPU SPV I')).created).toBe(false)
  })

  it('a failed Base publish: the next run publishes Base on the plan that is there', async () => {
    const b = books(null, true)
    await expect(createPitchScenarios(ctx(b.admin), 'GPU SPV I')).rejects.toBeTruthy()
    expect(b.tables.forecast_plans.map(p => p.name)).toEqual(['Base case'])
    expect(b.tables.forecast_versions).toEqual([])
    const again = await createPitchScenarios(ctx(b.admin), 'GPU SPV I')
    expect(again.baseVersionId).toBe(b.tables.forecast_versions[0].id)
    expect(b.tables.forecast_versions).toHaveLength(1)
    expect(b.tables.forecast_plans.filter(p => p.name === 'Base case')).toHaveLength(1)
    expect(b.tables.forecast_plans).toHaveLength(6)
  })

  it("never overwrites a scenario someone has edited: only flows on accounts with no rule are added", async () => {
    const b = books()
    await createPitchScenarios(ctx(b.admin), 'GPU SPV I')
    const bal = b.tables.forecast_plans.find(p => p.name === 'Balanced')!
    // Someone replaces Balanced's datacenter rule with their own, and its insurance rule is lost.
    const dc = b.tables.forecast_rules.find(r => r.plan_id === bal.id && r.params.flow === 'datacenter')!
    Object.assign(dc, { method: 'fixed', params: { amount: 9_000 } })
    b.tables.forecast_rules = b.tables.forecast_rules.filter(r => !(r.plan_id === bal.id && r.params?.flow === 'insurance'))
    await createPitchScenarios(ctx(b.admin), 'GPU SPV I')
    expect(b.tables.forecast_rules.find(r => r.plan_id === bal.id && r.account_id === dc.account_id)).toMatchObject({ method: 'fixed', params: { amount: 9_000 } })
    expect(flowsOf(b, 'Balanced')).toContain('insurance')
    expect(b.tables.forecast_plans).toHaveLength(6)
  })

  it('books no journal entries (the #86 ground rule): forecast_* only, through forecast_save and forecast_publish', async () => {
    const b = books()
    await createPitchScenarios(ctx(b.admin), 'GPU SPV I')
    expect([...b.written].filter(t => !t.startsWith('forecast_'))).toEqual([])
    expect(new Set(b.rpc.mock.calls.map(c => c[0]))).toEqual(new Set(['forecast_save', 'forecast_publish']))
    // Every compiled entry the seed saved is a forecast entry; none names a journal source_ref.
    const saved = b.rpc.mock.calls.flatMap(c => c[1].p_entries ?? [])
    expect(saved.length).toBeGreaterThan(0)
    expect(saved.every((e: any) => !('source_ref' in e))).toBe(true)
  })

  it('gives a GPU SPV plan no fund-style fee or expense rules from construction terms', async () => {
    const b = books()
    await createPitchScenarios(ctx(b.admin), 'GPU SPV I')
    expect(b.tables.forecast_rules.every(r => r.method === 'linked_fleet')).toBe(true)
  })
})
