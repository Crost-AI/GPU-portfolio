import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import type { AccessContext } from '@/lib/access/effective'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * Forecast service hardening: a plan's window is bounded and checked before anything is written,
 * free text is typed and sized, the primary flag only moves with a save that went through, a
 * version freezes its construction and capital inside forecast_publish, and carry / manco detail
 * is redacted on the way out for callers without the grant.
 */

vi.mock('@/lib/accounting/http-vehicle', async orig => ({
  ...(await orig<typeof import('@/lib/accounting/http-vehicle')>()),
  resolveVehicleWithAccess: async (_a: unknown, _acc: unknown, name: string) => ({ name, kind: 'fund' }),
}))
vi.mock('@/lib/accounting/vehicle-id', async orig => ({
  ...(await orig<typeof import('@/lib/accounting/vehicle-id')>()),
  vehicleIdByName: async () => 'v1',
}))
vi.mock('@/lib/accounting/periods', async orig => ({
  ...(await orig<typeof import('@/lib/accounting/periods')>()),
  closedPeriodRanges: async () => [],
}))
vi.mock('@/lib/accounting/currency', async orig => ({
  ...(await orig<typeof import('@/lib/accounting/currency')>()),
  fundCurrency: async () => 'USD',
}))
vi.mock('@/lib/accounting/load', async orig => ({
  ...(await orig<typeof import('@/lib/accounting/load')>()),
  loadPostedLedger: async () => ({ postings: [] }),
}))
vi.mock('@/lib/forecast/linked', async orig => ({
  ...(await orig<typeof import('@/lib/forecast/linked')>()),
  loadLinkedDrivers: async () => ({ linked: new Map(), construction: null, gpShare: null, warnings: [] }),
}))
vi.mock('@/lib/accounting/construction-service', () => ({
  getConstructionModel: async () => ({
    actuals: { uncalledCapital: 0 }, grossTimeline: null, timeline: null,
    forecast: { returns: {}, capital: {} }, assumptions: { simulation: { lossRate: 0, dispersion: 0, holdSpreadYears: 0 } },
    asOf: '2026-10-01T00:00:00Z',
  }),
  loadConstructionSeed: async () => null,
}))

import { createPlan, getPlan, getPlanReturns, listFeeLinks, publishPlan, redactCarryEntry, savePlan, ForecastError } from '@/lib/forecast/service'

const FEATURES: FeatureVisibilityMap = {
  ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', management_company: 'everyone', gp_economics: 'everyone',
}
const access = (grants: AccessContext['grants']): AccessContext => ({
  fundId: 'f1', userId: 'u1', role: 'member', vehicles: { all: true, ids: [] }, features: FEATURES, grants, defaults: {},
})
const ACCOUNTING = access({ accounting: 'write' })
const EVERYTHING = access({ accounting: 'write', gp_economics: 'read', management_company: 'read' })

const thisMonth = new Date().toISOString().slice(0, 7)

const plan = (over: Record<string, unknown> = {}) => ({
  id: 'p1', fund_id: 'f1', vehicle_id: 'v1', kind: 'rolling_forecast', name: 'Base case', scenario: null, fiscal_year: null,
  start_month: `${thisMonth}-01`, end_month: `${thisMonth}-01`, horizon_months: 12, actuals_cutoff: null,
  opening_settlement_months: 1, include_construction: true, adjustments: null, construction: { stages: ['seed'] },
  capital: { policy: { calls: { reserve: 5 } } }, is_primary: false, status: 'active', revision: 3,
  compiled_at: null, compiled_cutoff: null, compiled_closed_through: null, created_at: '2026-01-01', updated_at: '2026-01-01',
  ...over,
})

function books(plans: Record<string, unknown>[], rpc: (name: string, args: any) => { data: unknown; error: unknown } = () => ({ data: null, error: null })) {
  const writes: { table: string; op: string; payload: any }[] = []
  const { admin, tables } = memoryAdmin({
    chart_of_accounts: [
      { id: 'cash', fund_id: 'f1', vehicle_id: 'v1', code: '1000', name: 'Cash', type: 'asset', subtype: 'cash', is_active: true },
      { id: 'exp', fund_id: 'f1', vehicle_id: 'v1', code: '6000', name: 'Expenses', type: 'expense', subtype: null, is_active: true },
    ],
    forecast_plans: plans,
    forecast_rules: [], forecast_overrides: [], forecast_versions: [], forecast_entries: [],
    manco_fee_links: [{ id: 'l1', fund_id: 'f1', manco_vehicle_id: 'm1', fund_vehicle_id: 'v1', every_months: 3, anchor_month: 1, direction: 'advance', cash_lag_months: 0, active: true }],
    fund_vehicles: [{ id: 'm1', fund_id: 'f1', name: 'Hemrock Management' }, { id: 'v1', fund_id: 'f1', name: 'Fund I' }],
  }, { before: (table, op, payload) => { writes.push({ table, op, payload }) } })
  const rpcSpy = vi.fn(async (name: string, args: any) => rpc(name, args))
  // The memory client has no .or(); fee links are read with one (loadFeeLinks), so serve them whole.
  const from = (table: string) => {
    if (table !== 'manco_fee_links') return (admin as any).from(table)
    const q: any = { select: () => q, eq: () => q, or: () => q, then: (res: any) => Promise.resolve({ data: tables.manco_fee_links, error: null }).then(res) }
    return q
  }
  return { admin: { from, rpc: rpcSpy } as any, tables, writes, rpc: rpcSpy }
}

const ctx = (admin: any, a: AccessContext = ACCOUNTING) => ({ admin, fundId: 'f1', userId: 'u1', access: a })

const statusOf = async (p: Promise<unknown>) => {
  try { await p; return 200 } catch (e) { if (e instanceof ForecastError) return e.status; throw e }
}

beforeEach(() => vi.clearAllMocks())

describe('a plan window is bounded, and checked before the plan row is written', () => {
  it('refuses an end month centuries out on create, inserting nothing', async () => {
    const b = books([])
    await expect(createPlan(ctx(b.admin), { vehicle: 'Fund I', kind: 'rolling_forecast', name: 'X', endMonth: '9999-12' }))
      .rejects.toThrow(/at most 240 months/)
    expect(b.writes).toEqual([])
    expect(b.rpc).not.toHaveBeenCalled()
  })

  it('refuses a non-text scenario as a 400, not a TypeError', async () => {
    const b = books([])
    expect(await statusOf(createPlan(ctx(b.admin), { vehicle: 'Fund I', kind: 'rolling_forecast', name: 'X', scenario: 42 as any }))).toBe(400)
    expect(await statusOf(createPlan(ctx(b.admin), { vehicle: 'Fund I', kind: 'rolling_forecast', name: 'X', scenario: 'x'.repeat(201) }))).toBe(400)
    expect(b.writes).toEqual([])
  })

  it('stores only the seed fields it knows, and removes a plan whose first save failed', async () => {
    const b = books([], () => ({ data: null, error: { message: 'boom' } }))
    await expect(createPlan(ctx(b.admin), {
      vehicle: 'Fund I', kind: 'rolling_forecast', name: 'X', horizonMonths: 12, seed: { from: 'blank', junk: 'x'.repeat(10_000) } as any,
    })).rejects.toBeTruthy()
    const insert = b.writes.find(w => w.table === 'forecast_plans' && w.op === 'insert')!
    expect((Array.isArray(insert.payload) ? insert.payload[0] : insert.payload).seed).toEqual({ from: 'blank' })
    // Not left behind as the entity's (first, so primary) plan.
    expect(b.tables.forecast_plans).toEqual([])
  })

  it('refuses a patched end month past the cap without touching the plan or its primary flag', async () => {
    const b = books([plan({ id: 'p0', is_primary: true }), plan()])
    await expect(savePlan(ctx(b.admin), { vehicle: 'Fund I', planId: 'p1', expectedRevision: 3, patch: { endMonth: '9999-12', isPrimary: true } }))
      .rejects.toThrow(/at most 240 months/)
    expect(b.writes).toEqual([])
    expect(b.rpc).not.toHaveBeenCalled()
  })

  it('moves the primary flag only once the save has gone through', async () => {
    const conflict = books([plan({ id: 'p0', is_primary: true }), plan()], () => ({ data: null, error: { code: 'PT409', message: 'changed' } }))
    expect(await statusOf(savePlan(ctx(conflict.admin), { vehicle: 'Fund I', planId: 'p1', expectedRevision: 3, patch: { isPrimary: true } }))).toBe(409)
    expect(conflict.tables.forecast_plans.filter(p => p.is_primary).map(p => p.id)).toEqual(['p0'])

    const ok = books([plan({ id: 'p0', is_primary: true }), plan()])
    await savePlan(ctx(ok.admin), { vehicle: 'Fund I', planId: 'p1', expectedRevision: 3, patch: { isPrimary: true } })
    expect(ok.tables.forecast_plans.filter(p => p.is_primary).map(p => p.id)).toEqual(['p1'])
  })
})

describe('publishing a version', () => {
  it('hands construction and capital to forecast_publish instead of updating the immutable version', async () => {
    const b = books([plan()], name => ({ data: name === 'forecast_publish' ? { id: 'ver1', versionNo: 1 } : null, error: null }))
    await publishPlan(ctx(b.admin), { vehicle: 'Fund I', planId: 'p1', expectedRevision: 3, status: 'published', label: '  Q3  ' })
    const [name, args] = b.rpc.mock.calls[0]
    expect(name).toBe('forecast_publish')
    expect(args).toMatchObject({ p_construction: { stages: ['seed'] }, p_capital: { policy: { calls: { reserve: 5 } } }, p_label: 'Q3' })
    expect(b.writes.filter(w => w.table === 'forecast_versions')).toEqual([])
  })

  it('refuses non-text notes as a 400', async () => {
    const b = books([plan()])
    expect(await statusOf(publishPlan(ctx(b.admin), { vehicle: 'Fund I', planId: 'p1', expectedRevision: 3, status: 'published', notes: { a: 1 } as any }))).toBe(400)
    expect(b.rpc).not.toHaveBeenCalled()
  })
})

describe('carry detail is gp_economics', () => {
  it('redacts a carry entry\'s recipients and split, key included, and leaves everything else alone', () => {
    const e = { memo: 'Carried interest to GP I LLC 60%, Jane Doe 40%', key: 'construction|carry_distribution|2027-03-31|Carried interest to GP I LLC 60%, Jane Doe 40%' }
    expect(redactCarryEntry(e, false)).toEqual({ memo: 'Carried interest', key: 'construction|carry_distribution|2027-03-31|Carried interest' })
    expect(redactCarryEntry(e, true)).toBe(e)
    const other = { memo: 'Distribution to the LPs', key: 'construction|distribution|2027-03-31|Distribution to the LPs' }
    expect(redactCarryEntry(other, false)).toBe(other)
  })

  it('returns the plan\'s carry memos redacted to an accounting-only member, in full with the grant', async () => {
    const memo = 'Carried interest to GP I LLC 60%, Jane Doe 40%'
    const adjustments = { entries: [{ id: 'c1', date: `${thisMonth}-15`, memo, postings: [{ accountId: 'exp', amount: 10 }, { accountId: 'cash', amount: -10 }] }], removed: [] }
    const b = books([plan({ adjustments })])
    const redacted = await getPlan(ctx(b.admin), { vehicle: 'Fund I', planId: 'p1' })
    expect(JSON.stringify(redacted.entries)).not.toContain('Jane Doe')
    expect(redacted.entries.map(e => e.memo)).toContain('Carried interest')
    const full = await getPlan(ctx(b.admin, EVERYTHING), { vehicle: 'Fund I', planId: 'p1' })
    expect(full.entries.map(e => e.memo)).toContain(memo)
  })

  it('flags plan returns as carry-restricted without the grant', async () => {
    const b = books([plan({ is_primary: true })])
    const r = await getPlanReturns(ctx(b.admin), { vehicle: 'Fund I', planId: 'p1' })
    expect(r.carryRestricted).toBe(true)
    expect(r.base.totals.carry).toBe(0)
    expect((await getPlanReturns(ctx(b.admin, EVERYTHING), { vehicle: 'Fund I', planId: 'p1' })).carryRestricted).toBe(false)
  })
})

describe('fee links on the fund side', () => {
  it('do not name the manco or its billing cycle without management_company', async () => {
    const b = books([])
    const masked = await listFeeLinks(ctx(b.admin), { vehicle: 'Fund I' })
    expect(JSON.stringify(masked)).not.toMatch(/Hemrock|quarterly|advance/)
    expect(masked.links[0]).toMatchObject({ fund: 'Fund I', everyMonths: null, direction: null })
    const full = await listFeeLinks(ctx(b.admin, EVERYTHING), { vehicle: 'Fund I' })
    expect(full.links[0]).toMatchObject({ manco: 'Hemrock Management', everyMonths: 3, description: 'quarterly in advance' })
  })
})
