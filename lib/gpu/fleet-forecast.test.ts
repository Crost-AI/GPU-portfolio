import { describe, expect, it } from 'vitest'
import { NO_CARRY, type VehicleCarryTerms } from '@/lib/accounting/carry'
import { FLEET_FLOWS } from '@/lib/forecast/rules'
import {
  FleetAssumptionsError, fleetFromRegister, fleetMonthly, fleetOpening, registerContingencySpent, scenarioTermsFor, validateFleetAssumptions,
} from './fleet-forecast'
import { PACK_FLEET, PACK_SCENARIO_TERMS, packAssumptions } from './fixtures/pack-v3-fleet'
import { runFleetScenario } from './scenario'
import type { GpuAsset, GpuAssetTypeRow } from './types'

const c = (n: number) => Math.round(n * 100)

describe('validateFleetAssumptions', () => {
  it('accepts every pack scenario and returns it unchanged', () => {
    for (const id of ['base', 'oversupply_50'] as const) {
      const a = packAssumptions(id, { cadence: 'quarterly', capex: { contingencyPct: 0.1, contingencySpent: 100_000, returnYear: 4 } })
      expect(validateFleetAssumptions(a)).toEqual(a)
    }
    const register = packAssumptions('base', { assets: 'register', overrides: { carryRate: 0.2 } })
    expect(validateFleetAssumptions(register)).toEqual(register)
  })

  it('keeps only the known fields', () => {
    const a = validateFleetAssumptions({ ...packAssumptions('base'), junk: 'x', datacenter: { ...packAssumptions('base').datacenter, junk: 1 } })
    expect('junk' in a).toBe(false)
    expect('junk' in a.datacenter).toBe(false)
  })

  it('refuses what the engine cannot run, naming the field', () => {
    const base = packAssumptions('base')
    const cases: [unknown, RegExp][] = [
      [{ ...base, version: 2 }, /version/],
      [{ ...base, years: 0 }, /fleet\.years/],
      [{ ...base, years: 21 }, /fleet\.years/],
      [{ ...base, saleYear: 6 }, /saleYear/],
      [{ ...base, types: {} }, /at least one/],
      [{ ...base, types: { ...base.types, b300: { anchorRate: 9, priceChanges: [0, 0] } } }, /priceChanges/],
      [{ ...base, utilization: 1.2 }, /utilization/],
      [{ ...base, insurancePct: -0.1 }, /insurancePct/],
      [{ ...base, salvagePct: 2 }, /salvagePct/],
      [{ ...base, datacenter: { ...base.datacenter, contingencyPct: 1.5 } }, /contingencyPct/],
      [{ ...base, cadence: 'weekly' }, /cadence/],
      [{ ...base, assets: [] }, /assets/],
      [{ ...base, assets: [{ ...PACK_FLEET[0], typeCode: 'gb300' }] }, /typeCode/],
      [{ ...base, startMonth: '2027-13' }, /startMonth/],
      [{ ...base, overrides: { carryRate: 2 } }, /carryRate/],
      [null, /fleet must be an object/],
    ]
    for (const [raw, msg] of cases) expect(() => validateFleetAssumptions(raw), String(msg)).toThrow(msg)
    expect(() => validateFleetAssumptions({ ...base, years: 0 })).toThrow(FleetAssumptionsError)
  })
})

describe('fleetMonthly: each plan year spread evenly over its twelve months (R7)', () => {
  const a = packAssumptions('base')
  const r = runFleetScenario(a, PACK_FLEET, PACK_SCENARIO_TERMS)
  const m = fleetMonthly(a, r)
  const yearSum = (flow: (typeof FLEET_FLOWS)[number], y: number) =>
    m.yearMonths[y].reduce((s, month) => s + c(m.flows[flow].get(month) ?? 0), 0)

  it("each flow's plan-year total is the engine's to the cent", () => {
    r.operating.slice(1).forEach((o, y) => {
      expect(yearSum('revenue', y)).toBe(c(o.revenue))
      expect(yearSum('processing_fee', y)).toBe(c(o.processing))
      expect(yearSum('datacenter', y)).toBe(c(o.datacenter))
      expect(yearSum('contingency', y)).toBe(c(o.contingency))
      expect(yearSum('insurance', y)).toBe(c(o.insurance))
      expect(yearSum('depreciation', y)).toBe(c(o.depreciation))
      expect(yearSum('fee', y)).toBe(c(r.waterfall[y].fee))
    })
  })

  it('plan years run from the start month, and the sale lands in the last month at book', () => {
    expect(m.yearMonths[0][0]).toBe('2027-01')
    expect(m.yearMonths[4][11]).toBe('2031-12')
    expect([...m.flows.disposal]).toEqual([['2031-12', 130_500]])
    expect(m.disposal).toEqual({ month: '2031-12', proceeds: 130_500, basis: 1_305_000, accumulated: 1_174_500 })
    // Even: no month differs from another in its year by more than a cent.
    const y1 = m.yearMonths[0].map(x => c(m.flows.revenue.get(x)!))
    expect(Math.max(...y1) - Math.min(...y1)).toBeLessThanOrEqual(1)
  })
})

describe('the register as the engine fleet', () => {
  const types: GpuAssetTypeRow[] = [
    { id: 't1', fund_id: 'f1', code: 'b200', label: 'B200', gpu_model: null, gpus_per_server: 8, anchor_rate: 6, notes: null },
    { id: 't2', fund_id: 'f1', code: 'mi300', label: 'MI300', gpu_model: null, gpus_per_server: 8, anchor_rate: null, notes: null },
  ]
  const asset = (over: Partial<GpuAsset>): GpuAsset => ({
    id: 'a', fund_id: 'f1', vehicle_id: 'v1', asset_type_id: 't1', name: 'srv', serials: [], vendor_id: null, status: 'in_service',
    gpu_count: 8, hardware_cost: 410_000, purchase_date: null, in_service_date: null, useful_life_months: 60, salvage_value: 41_000,
    depreciation_convention: 'full_month', tax_method: 'book', tax_bonus_pct: 0, tax_life_years: null, insurance_basis: null,
    datacenter_contract_id: null, purchase_entry_id: null, disposed_on: null, disposal_proceeds: null, disposal_entry_id: null, notes: null,
    capitalized_costs: 12_000, ...over,
  })

  it('takes planned and in-service servers with their type, anchor rate and capitalized costs', () => {
    const a = packAssumptions('base', { assets: 'register' })
    const assets = [
      asset({ id: 'a1', name: 'srv-1' }), asset({ id: 'a2', name: 'srv-2', status: 'planned', capitalized_costs: 0 }),
      asset({ id: 'a3', name: 'srv-3', status: 'disposed' }), asset({ id: 'a4', name: 'srv-4', asset_type_id: 't2' }),
      asset({ id: 'a5', name: 'srv-5', asset_type_id: null }),
    ]
    const out = fleetFromRegister(a, assets, types)
    expect(out.fleet).toEqual([
      { typeCode: 'b200', servers: 1, gpusPerServer: 8, hardwareCost: 410_000, capitalizedCosts: 12_000 },
      { typeCode: 'b200', servers: 1, gpusPerServer: 8, hardwareCost: 410_000, capitalizedCosts: 0 },
    ])
    expect(out.types.b200).toEqual({ anchorRate: 6, priceChanges: a.types.b200.priceChanges })
    expect(out.types.b300).toEqual(a.types.b300)
    expect(out.warnings).toEqual([
      'srv-4 is a mi300, which has no price path in this scenario, so it is left out',
      'srv-5 has no server type, so the scenario leaves it out',
    ])
    // contingencySpent from the register: Σ capitalized costs, disposed servers included.
    expect(registerContingencySpent(a, out.fleet, assets)).toBe(12_000 * 4)
  })

  it('an empty register is a warning, not an error', () => {
    const out = fleetFromRegister(packAssumptions('base', { assets: 'register' }), [], types)
    expect(out.fleet).toEqual([])
    expect(out.warnings).toEqual(['The asset register has no planned or in-service servers, so this scenario forecasts nothing yet'])
  })
})

describe('scenarioTermsFor', () => {
  it("uses the vehicle's fee and distributable-cash terms", () => {
    const carry: VehicleCarryTerms = {
      ...NO_CARRY, kind: 'distributable_cash', carryRate: 0.2, prefRate: 0.07, prefDayCount: 'act_365', rocLpShare: 0.9,
      recipients: [{ lpEntityId: 'gp', pct: 100 }],
    }
    const { terms, warnings } = scenarioTermsFor(carry, {
      basis: 'gross_revenue', annualRate: 0.04, revenueSubtypes: ['rental_revenue'], frequency: 'monthly', payeeVehicleId: null,
    } as any)
    expect(terms).toEqual({ feeRate: 0.04, waterfall: { prefRate: 0.07, dayCount: 'act_365', rocLpShare: 0.9, carryRate: 0.2, recipients: [{ lpEntityId: 'gp', pct: 100 }] } })
    expect(warnings).toEqual([])
  })

  it("falls back to the model pack's terms, saying so, when the vehicle has none", () => {
    const { terms, warnings } = scenarioTermsFor(NO_CARRY, null)
    expect(terms).toEqual(PACK_SCENARIO_TERMS)
    expect(warnings).toHaveLength(2)
  })
})

describe("a pitch's opening and the R8 release", () => {
  it('the pack: 1,435,500 raised, 1,305,000 bought, the 130,500 contingency consumed, nothing released', () => {
    const a = packAssumptions('base')
    const r = runFleetScenario(a, PACK_FLEET, PACK_SCENARIO_TERMS)
    expect(fleetOpening(a, r)).toEqual({ month: '2027-01', raised: 1_435_500, purchase: 1_305_000, consumed: 130_500 })
    expect(fleetMonthly(a, r).contingencyRelease).toBeNull()
  })

  it('100,000 spent: 30,500 released in the first month of the return year, as the engine pays it', () => {
    const a = packAssumptions('oversupply_50', { capex: { contingencyPct: 0.1, contingencySpent: 100_000 } })
    const r = runFleetScenario(a, PACK_FLEET, PACK_SCENARIO_TERMS)
    expect(fleetOpening(a, r)).toMatchObject({ raised: 1_435_500, purchase: 1_305_000, consumed: 100_000 })
    expect(fleetMonthly(a, r).contingencyRelease).toEqual({ month: '2031-01', amount: 30_500 })
    expect(r.waterfall[4].contingencyReturn).toBe(30_500)
    const early = { ...a, capex: { ...a.capex, returnYear: 2 } }
    expect(fleetMonthly(early, runFleetScenario(early, PACK_FLEET, PACK_SCENARIO_TERMS)).contingencyRelease).toEqual({ month: '2028-01', amount: 30_500 })
  })
})
