import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GPU_SPV_CHART } from '@/lib/accounting/chart'
import { NO_CARRY } from '@/lib/accounting/carry'
import type { Account } from '@/lib/accounting/types'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * A GPU SPV's fleet scenario compiled into the monthly forecast (gpu-P4 B1): the linked_fleet
 * drivers come from runFleetScenario once per plan, each plan year spread over its months, and the
 * compiled plan's annual totals are the engine's to the cent, flow by flow.
 */

const carryTerms = vi.fn(async () => NO_CARRY)
const feeTerms = vi.fn(async (): Promise<any> => null)
const listAssets = vi.fn(async (): Promise<any[]> => [])
vi.mock('@/lib/accounting/carry', async orig => ({ ...(await orig<typeof import('@/lib/accounting/carry')>()), loadCarryTerms: () => carryTerms() }))
vi.mock('@/lib/gpu/fee', async orig => ({ ...(await orig<typeof import('@/lib/gpu/fee')>()), loadFeeTerms: () => feeTerms() }))
vi.mock('@/lib/gpu/assets', async orig => ({ ...(await orig<typeof import('@/lib/gpu/assets')>()), listAssets: () => listAssets() }))

import { loadLinkedDrivers } from '@/lib/forecast/linked'
import { buildPlan, type PlanRuleRow } from '@/lib/forecast/plan'
import { validateRule, type FleetFlow } from '@/lib/forecast/rules'
import { packAssumptions, PACK_FLEET, PACK_SCENARIO_TERMS } from '@/lib/gpu/fixtures/pack-v3-fleet'
import { runFleetScenario } from '@/lib/gpu/scenario'
import type { MonthKey } from '@/lib/forecast/months'

const ACCOUNTS: Account[] = GPU_SPV_CHART.map(a => ({
  id: `acct-${a.code}`, fundId: 'f1', code: a.code, name: a.name, type: a.type as Account['type'], subtype: a.subtype ?? null, lpEntityId: null, companyId: null,
}))
const id = (code: string) => `acct-${code}`

/** The seed's mapping: one linked_fleet rule per flow on the GPU chart. */
const FLOW_ACCOUNT: Record<FleetFlow, string> = {
  revenue: '4000', processing_fee: '5150', datacenter: '5100', contingency: '5900', insurance: '5200', depreciation: '5300', disposal: '4500', fee: '5000',
}
const RULES: PlanRuleRow[] = (Object.keys(FLOW_ACCOUNT) as FleetFlow[]).map(flow => ({
  id: `r-${flow}`, accountId: id(FLOW_ACCOUNT[flow]), rule: validateRule('linked_fleet', { flow }), cashTiming: { mode: 'same' },
}))

const VEHICLE = { id: 'v1', name: 'GPU SPV I', kind: 'gpu_spv' }
const ctx = { admin: memoryAdmin({ gpu_asset_types: [] }).admin as any, fundId: 'f1', access: {} as any }

async function compiled(fleet: unknown, vehicle = VEHICLE) {
  const linked = await loadLinkedDrivers(ctx, vehicle, RULES, false, 'p1', fleet)
  const built = buildPlan({
    kind: 'rolling_forecast', fiscalYear: null, startMonth: '2027-01', endMonth: '2031-12', horizonMonths: null, cutoff: '2026-12',
    vehicleKind: vehicle.kind, accounts: ACCOUNTS, actuals: [], closedFrom: null, closedThrough: null, rules: RULES, overrides: [],
    currency: 'USD', linked: linked.linked,
  })
  return { linked, built }
}

/** Natural-side P&L amount on an account per plan year (Y1 = 2027). */
function byYear(entries: { entryDate: string; postings: { accountId: string; amount: number }[] }[], code: string, income: boolean) {
  const out = [0, 0, 0, 0, 0]
  for (const e of entries) for (const p of e.postings) {
    if (p.accountId !== id(code)) continue
    out[Number(e.entryDate.slice(0, 4)) - 2027] += Math.round((income ? -p.amount : p.amount) * 100)
  }
  return out
}
const c = (n: number) => Math.round(n * 100)

beforeEach(() => vi.clearAllMocks())

describe('linked_fleet compiles the engine into the monthly plan', () => {
  const a = packAssumptions('base', { startMonth: '2027-01' })
  const engine = runFleetScenario(a, PACK_FLEET, PACK_SCENARIO_TERMS)

  it("each flow's plan-year total equals the engine's annual figure exactly", async () => {
    const { built, linked } = await compiled(a)
    expect(linked.fleet?.result.returns.investor.total).toBe(engine.returns.investor.total)
    const op = engine.operating.slice(1)
    expect(byYear(built.entries, '4000', true)).toEqual(op.map(o => c(o.revenue)))
    expect(byYear(built.entries, '5150', false)).toEqual(op.map(o => c(o.processing)))
    expect(byYear(built.entries, '5100', false)).toEqual(op.map(o => c(o.datacenter)))
    expect(byYear(built.entries, '5900', false)).toEqual(op.map(o => c(o.contingency)))
    expect(byYear(built.entries, '5200', false)).toEqual(op.map(o => c(o.insurance)))
    expect(byYear(built.entries, '5300', false)).toEqual(op.map(o => c(o.depreciation)))
    expect(byYear(built.entries, '5000', false)).toEqual(engine.waterfall.map(w => c(w.fee)))
    // Sold at book: no gain or loss.
    expect(byYear(built.entries, '4500', true)).toEqual([0, 0, 0, 0, 0])
    for (const e of built.entries) expect(e.postings.reduce((s, p) => s + c(p.amount), 0), e.memo).toBe(0)
  })

  it('revenue is Dr 1150 / Cr 4000, received the month after; depreciation is Dr 5300 / Cr 1650', async () => {
    const { built } = await compiled(a)
    const jan = built.entries.filter(e => e.entryDate === '2027-01-31')
    const rev = jan.find(e => e.accountId === id('4000'))!
    expect(rev.postings.map(p => p.accountId).sort()).toEqual([id('1150'), id('4000')])
    const received = built.entries.find(e => e.accountId === id('4000') && e.kind === 'settlement' && e.entryDate === '2027-02-28')!
    expect(received.postings.find(p => p.accountId === id('1000'))!.amount).toBe(-rev.postings.find(p => p.accountId === id('4000'))!.amount)
    const dep = jan.find(e => e.accountId === id('5300'))!
    expect(dep.postings).toEqual([
      { accountId: id('5300'), amount: 19_575, currency: 'USD' }, { accountId: id('1650'), amount: -19_575, currency: 'USD' },
    ])
    // No depreciation entry touches cash.
    expect(built.entries.filter(e => e.accountId === id('5300')).every(e => e.postings.every(p => p.accountId !== id('1000')))).toBe(true)
  })

  it('the hardware sale lands in the sale month as proceeds at book', async () => {
    const { built } = await compiled(a)
    const sale = built.entries.filter(e => e.accountId === id('4500'))
    expect(sale).toHaveLength(1)
    expect(sale[0]).toMatchObject({ entryDate: '2031-12-31', kind: 'proceeds' })
    expect(sale[0].postings).toEqual([
      { accountId: id('1000'), amount: 130_500, currency: 'USD' },
      { accountId: id('1650'), amount: 1_174_500, currency: 'USD' },
      { accountId: id('1600'), amount: -1_305_000, currency: 'USD' },
    ])
  })

  it('runs the engine once per plan, whatever the number of fleet rules', async () => {
    await compiled(a)
    expect(carryTerms).toHaveBeenCalledTimes(1)
    expect(feeTerms).toHaveBeenCalledTimes(1)
  })

  it('a register plan with an empty register is a warning, not an error', async () => {
    const { built, linked } = await compiled(packAssumptions('base', { assets: 'register' }))
    expect(linked.fleet).toBeNull()
    expect(linked.warnings).toContain('The asset register has no planned or in-service servers, so this scenario forecasts nothing yet')
    expect(built.entries).toEqual([])
  })

  it('fleet rules without a fleet, or on a vehicle that is not a GPU SPV, forecast nothing and say why', async () => {
    const none = await compiled(null)
    expect(none.built.entries).toEqual([])
    expect(none.linked.warnings).toContain(`A fleet rule is on ${VEHICLE.name}'s plan, but the plan has no fleet scenario`)
    const vc = await compiled(a, { ...VEHICLE, kind: 'fund' })
    expect(vc.linked.fleet).toBeNull()
    expect(carryTerms).toHaveBeenCalledTimes(0)
  })

  it('an unrunnable fleet is a warning on the plan', async () => {
    const { linked } = await compiled({ ...a, saleYear: 9 })
    expect(linked.fleet).toBeNull()
    expect(linked.warnings.some(w => /fleet assumptions cannot be run: fleet\.saleYear/.test(w))).toBe(true)
  })
})

describe('the plan months follow the fleet start month', () => {
  it('a plan year that starts mid-calendar-year still totals the engine year', async () => {
    const a = packAssumptions('base', { startMonth: '2027-07', saleYear: 1 })
    const engine = runFleetScenario(a, PACK_FLEET, PACK_SCENARIO_TERMS)
    const linked = await loadLinkedDrivers(ctx, VEHICLE, RULES, false, 'p1', a)
    const rev = linked.linked.get('r-revenue')![0].amounts
    const months = [...rev.keys()].sort() as MonthKey[]
    expect(months[0]).toBe('2027-07')
    expect(months[months.length - 1]).toBe('2028-06')
    expect([...rev.values()].reduce((s, v) => s + c(v), 0)).toBe(c(engine.operating[1].revenue))
  })
})
