// A fleet scenario inside the monthly forecast (gpu-P4 B1, pivot plan §5.1).
//
// A scenario is a forecast plan on a gpu_spv vehicle whose `fleet` column holds `FleetAssumptions`.
// The forecast runs `runFleetScenario` once per plan and takes its annual figures month by month:
// each plan year's figure spread evenly over its twelve months (R7), so the compiled plan's annual
// totals are the engine's to the cent. This file is the pure half: checking stored assumptions,
// turning the asset register into the engine's fleet, reading the vehicle's terms, and the spread.
// lib/forecast/linked.ts loads the inputs and lib/forecast/plan.ts books the entries.

import { apportionCents } from '@/lib/accounting/allocation'
import { roundCents } from '@/lib/accounting/ledger'
import type { VehicleCarryTerms } from '@/lib/accounting/carry'
import { cashWaterfallTerms } from '@/lib/accounting/distribution-waterfall'
import { addMonths, isMonthKey, type MonthKey } from '@/lib/forecast/months'
import { MAX_AMOUNT } from '@/lib/forecast/rules'
import type { FleetFlow } from '@/lib/forecast/rules'
import { contingencyPosition } from './contingency'
import type { VehicleFeeTerms } from './fee'
import { PACK_SCENARIO_TERMS } from './fixtures/pack-v3-fleet'
import type { Cadence, FleetAssumptions, FleetScenarioResult, PlannedAsset, ScenarioTerms } from './scenario'
import type { GpuAsset, GpuAssetTypeRow } from './types'

export class FleetAssumptionsError extends Error {}

const MAX_YEARS = 20
const MAX_TYPES = 50
const MAX_ASSETS = 5000
const CADENCES: Cadence[] = ['annual', 'quarterly', 'monthly']

const fail = (m: string): never => { throw new FleetAssumptionsError(m) }
const obj = (v: unknown, field: string): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail(`${field} must be an object`)
const num = (v: unknown, field: string, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fail(`${field} must be a number from ${min} to ${max}`)
const pct = (v: unknown, field: string) => num(v, field, 0, 1)
const int = (v: unknown, field: string, min: number, max: number): number =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? v as number : fail(`${field} must be a whole number from ${min} to ${max}`)

/**
 * Check fleet assumptions as stored on a plan (PATCH `fleet`), returning only their known fields.
 * Throws FleetAssumptionsError naming the field at fault.
 */
export function validateFleetAssumptions(raw: unknown): FleetAssumptions {
  const a = obj(raw, 'fleet')
  if (a.version !== 1) fail('fleet.version must be 1')
  if (!isMonthKey(a.startMonth)) fail('fleet.startMonth must be YYYY-MM')
  const years = int(a.years, 'fleet.years', 1, MAX_YEARS)
  const saleYear = int(a.saleYear, 'fleet.saleYear', 1, years)

  const typesRaw = obj(a.types, 'fleet.types')
  const codes = Object.keys(typesRaw)
  if (codes.length === 0) fail('fleet.types needs at least one server type')
  if (codes.length > MAX_TYPES) fail(`fleet.types holds at most ${MAX_TYPES} server types`)
  const types: FleetAssumptions['types'] = {}
  for (const code of codes) {
    const t = obj(typesRaw[code], `fleet.types.${code}`)
    if (!Array.isArray(t.priceChanges) || t.priceChanges.length !== years) fail(`fleet.types.${code}.priceChanges must hold one change per year (${years})`)
    types[code] = {
      anchorRate: num(t.anchorRate, `fleet.types.${code}.anchorRate`, 0, 10_000),
      priceChanges: (t.priceChanges as unknown[]).map((g, k) => num(g, `fleet.types.${code}.priceChanges[${k}]`, -0.99, 10)),
    }
  }

  let utilization: FleetAssumptions['utilization']
  if (typeof a.utilization === 'number') utilization = pct(a.utilization, 'fleet.utilization')
  else {
    const u = obj(a.utilization, 'fleet.utilization')
    utilization = {}
    for (const code of codes) {
      const path = u[code]
      if (!Array.isArray(path) || path.length !== years) fail(`fleet.utilization.${code} must hold one figure per year (${years})`)
      utilization[code] = (path as unknown[]).map((x, k) => pct(x, `fleet.utilization.${code}[${k}]`))
    }
  }

  let assets: FleetAssumptions['assets']
  if (a.assets === 'register') assets = 'register'
  else {
    if (!Array.isArray(a.assets) || a.assets.length === 0) fail("fleet.assets must be 'register' or a list of planned assets")
    if ((a.assets as unknown[]).length > MAX_ASSETS) fail(`fleet.assets holds at most ${MAX_ASSETS} entries`)
    assets = (a.assets as unknown[]).map((x, k): PlannedAsset => {
      const p = obj(x, `fleet.assets[${k}]`)
      if (typeof p.typeCode !== 'string' || !types[p.typeCode]) fail(`fleet.assets[${k}].typeCode must be one of fleet.types`)
      return {
        typeCode: p.typeCode as string,
        servers: int(p.servers, `fleet.assets[${k}].servers`, 1, 100_000),
        gpusPerServer: int(p.gpusPerServer, `fleet.assets[${k}].gpusPerServer`, 1, 1_000),
        hardwareCost: num(p.hardwareCost, `fleet.assets[${k}].hardwareCost`, 0, MAX_AMOUNT),
        ...(p.capitalizedCosts == null ? {} : { capitalizedCosts: num(p.capitalizedCosts, `fleet.assets[${k}].capitalizedCosts`, 0, MAX_AMOUNT) }),
      }
    })
  }

  const dc = obj(a.datacenter, 'fleet.datacenter')
  const capex = obj(a.capex, 'fleet.capex')
  const out: FleetAssumptions = {
    version: 1,
    startMonth: a.startMonth as MonthKey,
    years,
    saleYear,
    assets,
    hoursPerYear: num(a.hoursPerYear, 'fleet.hoursPerYear', 1, 8_784),
    priceChangeTiming: pct(a.priceChangeTiming, 'fleet.priceChangeTiming'),
    types,
    utilization,
    datacenter: {
      monthly: num(dc.monthly, 'fleet.datacenter.monthly', 0, MAX_AMOUNT),
      escalator: pct(dc.escalator, 'fleet.datacenter.escalator'),
      firstEscalationYear: int(dc.firstEscalationYear, 'fleet.datacenter.firstEscalationYear', 1, MAX_YEARS + 1),
      contingencyPct: pct(dc.contingencyPct, 'fleet.datacenter.contingencyPct'),
    },
    processingFeePct: pct(a.processingFeePct, 'fleet.processingFeePct'),
    insurancePct: pct(a.insurancePct, 'fleet.insurancePct'),
    capex: {
      contingencyPct: pct(capex.contingencyPct, 'fleet.capex.contingencyPct'),
      contingencySpent: capex.contingencySpent == null ? null : num(capex.contingencySpent, 'fleet.capex.contingencySpent', 0, MAX_AMOUNT),
      ...(capex.returnYear == null ? {} : { returnYear: int(capex.returnYear, 'fleet.capex.returnYear', 1, saleYear) }),
    },
    salvagePct: pct(a.salvagePct, 'fleet.salvagePct'),
    lifeYears: num(a.lifeYears, 'fleet.lifeYears', 0.25, 50),
  }
  if (a.cadence != null) {
    if (!CADENCES.includes(a.cadence as Cadence)) fail("fleet.cadence must be 'annual', 'quarterly' or 'monthly'")
    out.cadence = a.cadence as Cadence
  }
  if (a.overrides != null) {
    const o = obj(a.overrides, 'fleet.overrides')
    const overrides: NonNullable<FleetAssumptions['overrides']> = {}
    for (const k of ['feeRate', 'prefRate', 'carryRate', 'rocLpShare'] as const) {
      if (o[k] != null) overrides[k] = pct(o[k], `fleet.overrides.${k}`)
    }
    out.overrides = overrides
  }
  return out
}

/**
 * The register as the engine's fleet: planned and in-service servers, one PlannedAsset each, with
 * their type's GPUs per server. The register's anchor rate, where set, replaces the plan's for that
 * type; the price path is always the plan's. A server with no type, or a type the plan has no price
 * path for, is left out with a warning rather than guessed at.
 */
export function fleetFromRegister(
  a: FleetAssumptions, assets: GpuAsset[], types: GpuAssetTypeRow[],
): { fleet: PlannedAsset[]; types: FleetAssumptions['types']; warnings: string[] } {
  const byId = new Map(types.map(t => [t.id, t]))
  const priced: FleetAssumptions['types'] = { ...a.types }
  const fleet: PlannedAsset[] = []
  const warnings: string[] = []
  const live = assets.filter(x => x.status === 'planned' || x.status === 'in_service')
  for (const x of live) {
    const t = x.asset_type_id ? byId.get(x.asset_type_id) : undefined
    if (!t) { warnings.push(`${x.name} has no server type, so the scenario leaves it out`); continue }
    if (!a.types[t.code]) { warnings.push(`${x.name} is a ${t.code}, which has no price path in this scenario, so it is left out`); continue }
    if (t.anchor_rate != null) priced[t.code] = { ...priced[t.code], anchorRate: Number(t.anchor_rate) }
    fleet.push({
      typeCode: t.code, servers: 1, gpusPerServer: t.gpus_per_server, hardwareCost: Number(x.hardware_cost),
      capitalizedCosts: Number(x.capitalized_costs ?? 0),
    })
  }
  if (!live.length) warnings.push('The asset register has no planned or in-service servers, so this scenario forecasts nothing yet')
  return { fleet, types: priced, warnings }
}

/**
 * `capex.contingencySpent` when the plan leaves it null and runs on the register: what the register
 * has capitalized so far (installation, shipping, spares), so the unspent rest is returned (R8).
 */
export function registerContingencySpent(a: FleetAssumptions, fleet: PlannedAsset[], assets: GpuAsset[]): number {
  const hardware = fleet.reduce((s, f) => s + f.servers * f.hardwareCost, 0)
  return contingencyPosition(hardware * a.capex.contingencyPct, assets).spent
}

/**
 * The scenario's terms from the vehicle: its gross-revenue fee and its distributable-cash
 * waterfall. A vehicle that has not set them yet runs on the model pack's (5% fee; 8% pref on
 * unreturned capital, 100% return of capital, 30% split), said in a warning, so a pitch on a new
 * vehicle reproduces the pack. The plan's `overrides` are applied by the engine.
 */
export function scenarioTermsFor(carry: VehicleCarryTerms, fee: VehicleFeeTerms | null): { terms: ScenarioTerms; warnings: string[] } {
  const warnings: string[] = []
  const pack = PACK_SCENARIO_TERMS
  if (!fee) warnings.push('This vehicle has no management-fee terms yet, so the scenario charges the model pack’s 5% of gross revenue')
  let waterfall = pack.waterfall
  if (carry.kind === 'distributable_cash') {
    const t = cashWaterfallTerms(carry)
    waterfall = { ...t, recipients: t.recipients.length ? t.recipients : pack.waterfall.recipients }
  } else {
    warnings.push('This vehicle has no distributable-cash waterfall terms yet, so the scenario uses the model pack’s (8% pref, 30% profit share)')
  }
  return { terms: { feeRate: fee?.annualRate ?? pack.feeRate, waterfall }, warnings }
}

/** The disposal in the sale month: cash in at book, cost and accumulated depreciation cleared. */
export interface FleetDisposal {
  month: MonthKey
  proceeds: number
  /** Gross cost of the fleet (hardware plus capitalized costs). */
  basis: number
  /** Depreciation charged through the sale. */
  accumulated: number
}

export interface FleetMonthly {
  /** Natural-side amount per month per flow; `disposal` is the sale proceeds in the sale month. */
  flows: Record<FleetFlow, Map<MonthKey, number>>
  disposal: FleetDisposal | null
  /** Plan year y covers months startMonth + 12(y−1) … + 11. */
  yearMonths: MonthKey[][]
}

const toCents = (n: number) => Math.round(roundCents(n) * 100)

/** Spread each plan year's figure evenly over its twelve months, in cents, so a year sums exactly. */
function spread(byYear: number[], yearMonths: MonthKey[][]): Map<MonthKey, number> {
  const out = new Map<MonthKey, number>()
  byYear.forEach((figure, k) => {
    const parts = apportionCents(toCents(figure), Array(12).fill(1))
    yearMonths[k].forEach((m, i) => { if (parts[i]) out.set(m, parts[i] / 100) })
  })
  return out
}

/** The engine's annual figures as monthly amounts (R7: even within each plan year). */
export function fleetMonthly(a: FleetAssumptions, r: FleetScenarioResult): FleetMonthly {
  const op = r.operating.slice(1)
  const yearMonths = op.map((_, k) => Array.from({ length: 12 }, (_, i) => addMonths(a.startMonth, 12 * k + i)))
  const flows: FleetMonthly['flows'] = {
    revenue: spread(op.map(o => o.revenue), yearMonths),
    processing_fee: spread(op.map(o => o.processing), yearMonths),
    datacenter: spread(op.map(o => o.datacenter), yearMonths),
    contingency: spread(op.map(o => o.contingency), yearMonths),
    insurance: spread(op.map(o => o.insurance), yearMonths),
    depreciation: spread(op.map(o => o.depreciation), yearMonths),
    fee: spread(r.waterfall.map(w => w.fee), yearMonths),
    disposal: new Map(),
  }
  const saleRow = op[op.length - 1]
  let disposal: FleetDisposal | null = null
  if (saleRow && saleRow.saleProceeds > 0) {
    const month = yearMonths[yearMonths.length - 1][11]
    flows.disposal.set(month, saleRow.saleProceeds)
    disposal = {
      month,
      proceeds: saleRow.saleProceeds,
      basis: r.operating[0].nbv,
      accumulated: roundCents(op.reduce((s, o) => s + o.depreciation, 0)),
    }
  }
  return { flows, disposal, yearMonths }
}
