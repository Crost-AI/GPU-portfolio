// The pure fleet scenario engine: one set of fleet assumptions in, the pack's tables out.
//
// WHAT IT REPRODUCES. GPU_Fund_Model_v3 (the "pack") is an annual model: revenue per server type
// from an anchored price path and a utilisation, four expense lines, a sale at book in the last
// year, and the distributable-cash waterfall once a year. Run on annual cadence with the pack's
// inputs this engine gives the pack's operating, waterfall and returns tables to the dollar (plan
// §5.2, fixtures §3.10). Every operating figure is computed unrounded and rounded to cents once,
// as the spreadsheet does, so `distributable` equals `packDistributableCash` to the cent.
//
// TWO CADENCES, BOTH LABELLED (Karl Q4). The pack distributes once a year; the vehicle distributes
// quarterly by default. Paying the same cash earlier lifts the IRR, so the annual block (the pack's
// headline) is always computed and the block for the vehicle's cadence sits beside it, each with its
// label. Sub-annual periods spread each year's operating cash evenly (R7), put the sale proceeds in
// the last period of the sale year and run the waterfall per period with `dayCount: 'periodic'`,
// which equals 30E/360 at period ends (P2 F8).
//
// THE TIERS ARE NOT REIMPLEMENTED HERE. Each period goes through `distribute` from
// `lib/gpu/waterfall.ts`, so the scenario and the actuals engine cannot disagree about a split.
// The one thing this file adds is the unspent-contingency return (R8), as a pre-step on the state.
//
// The fleet comes from the assumptions (a pitch fleet) or from the asset register through
// `resolveFleet`; the register is P1b, so that seam throws a typed error until it is wired.

import { accrue, contribute, distribute, emptyState, validateCashTerms, type CashWaterfallState, type CashWaterfallTerms } from './waterfall'
import { irrOf } from '@/lib/accounting/construction-forecast'
import { apportionCents } from '@/lib/accounting/allocation'
import { roundCents } from '@/lib/accounting/ledger'
import { addMonths, firstDay, isMonthKey, lastDay, type MonthKey } from '@/lib/forecast/months'

/** How often the vehicle distributes. Ad hoc declarations are modelled as quarterly. */
export type Cadence = 'annual' | 'quarterly' | 'monthly'

/** Karl Q4: quarterly unless the vehicle says otherwise. */
export const DEFAULT_CADENCE: Cadence = 'quarterly'

export const CADENCE_LABELS = {
  annual: 'Annual distributions (pack convention)',
  quarterly: 'Quarterly distributions',
  monthly: 'Monthly distributions',
} as const satisfies Record<Cadence, string>

const PERIODS_PER_YEAR: Record<Cadence, number> = { annual: 1, quarterly: 4, monthly: 12 }

export interface PlannedAsset {
  /** Key into `FleetAssumptions.types`. */
  typeCode: string
  servers: number
  gpusPerServer: number
  /** Per server: the quoted equipment cost. Insurance, salvage and the capex contingency are on this. */
  hardwareCost: number
  /** Per server: installation, shipping and spares actually capitalized (R8). Depreciation only. */
  capitalizedCosts?: number
}

export interface FleetAssumptions {
  version: 1
  /** Y1 starts here (pitch: launch month; live: in-service month). */
  startMonth: MonthKey
  /** Length of the price paths. */
  years: number
  /** Operates through this year, sold at book on its last day; the SPV then closes. */
  saleYear: number
  assets: 'register' | PlannedAsset[]
  hoursPerYear: number
  /** Share of a year's price change that lands in that year's average rate (0.5 = mid-year). */
  priceChangeTiming: number
  types: Record<string, { anchorRate: number; priceChanges: number[] }>
  /** One figure for every type and year, or per type per year. */
  utilization: number | Record<string, number[]>
  datacenter: { monthly: number; escalator: number; firstEscalationYear: number; contingencyPct: number }
  processingFeePct: number
  /** Of hardware cost, a year. */
  insurancePct: number
  /**
   * `contingencyPct` of hardware is raised with the capital. `contingencySpent` null is the pack:
   * all of it consumed, nothing returned. A number returns the unspent part to investors in
   * `returnYear` (default `saleYear`) as `contingencyReturn` (R8 / Q6).
   */
  capex: { contingencyPct: number; contingencySpent: number | null; returnYear?: number }
  salvagePct: number
  lifeYears: number
  /** Which returns block is primary; default quarterly (Karl Q4). */
  cadence?: Cadence
  /** Fee and waterfall terms come from the vehicle unless overridden here. */
  overrides?: { feeRate?: number; prefRate?: number; carryRate?: number; rocLpShare?: number }
}

export interface ScenarioTerms {
  /** Management fee, a share of gross revenue (`VehicleFeeTerms.annualRate`). */
  feeRate: number
  /** The vehicle's terms; `dayCount` is replaced by `periodic` here. */
  waterfall: CashWaterfallTerms
}

/** Y0 carries the capital raised as a negative net cash flow and nothing else. */
export interface OperatingRow {
  year: number
  revenueByType: Record<string, number>
  revenue: number
  datacenter: number
  processing: number
  insurance: number
  contingency: number
  expenses: number
  operatingProfit: number
  saleProceeds: number
  /** Unspent capex contingency released back in `capex.returnYear` (R8); 0 for the pack. */
  unspentContingency: number
  netCashFlow: number
  cumulative: number
  /** Straight line to salvage; informational, the cash tables ignore it (Dr 5300 / Cr 1650). */
  depreciation: number
  /** Net book value at year end. */
  nbv: number
}

/** One distribution period. `toManager` here is the waterfall's take only; the fee is outside it. */
export interface PeriodRow {
  period: number
  year: number
  /** Years from the Y0 contribution, for `irrOf`. */
  t: number
  date: string
  distributable: number
  unreturnedStart: number
  contingencyReturn: number
  preferred: number
  prefCarriedForward: number
  returnOfCapital: number
  managerRocShare: number
  profitToLP: number
  carry: number
  toInvestors: number
  toManager: number
  unreturnedAfter: number
}

/** The pack's investor waterfall table, one row per year (annual cadence). */
export interface WaterfallRow {
  year: number
  fee: number
  /** Operating profit − fee + sale (+ the unspent contingency in its return year). */
  distributable: number
  unreturnedStart: number
  /** R8: unspent contingency paid 100% to investors before the tiers; no fee, no carry. */
  contingencyReturn: number
  preferred: number
  prefCarriedForward: number
  returnOfCapital: number
  managerRocShare: number
  /** Cash left after capital is returned: profitToLP + carry. */
  afterCapital: number
  profitToLP: number
  carry: number
  toInvestors: number
  /** Fee plus the waterfall's take. */
  toManager: number
}

export interface ReturnsBlock {
  cadence: Cadence
  label: (typeof CADENCE_LABELS)[Cadence]
  investor: { irr: number | null; multiple: number; total: number }
  project: { irr: number | null; multiple: number }
  /** Investor net cash flows: −capital at t = 0, then each period's distribution at t = years. */
  flows: { t: number; amount: number }[]
  periods: PeriodRow[]
}

export interface FleetScenarioResult {
  /** The primary cadence: which `byCadence` block the vehicle actually distributes on. */
  cadence: Cadence
  /** GPU-hours rented ÷ available over the fund's life (the headline's "Utilization"). */
  utilization: number
  /** $/GPU-hour per type per year, unrounded; the pack's Year-5 table is `rates[t][4]`. */
  rates: Record<string, number[]>
  /** Y0..saleYear. */
  operating: OperatingRow[]
  /** Y1..saleYear, annual cadence. */
  waterfall: WaterfallRow[]
  returns: {
    capitalRaised: number
    /** Annual cadence (pack convention); the cadence blocks are in `byCadence`. */
    investor: { multiple: number; irr: number | null; total: number }
    project: { multiple: number; irr: number | null }
    /** First year cumulative project cash flow is above 0; null when never. */
    capitalRecoveredYear: number | null
    unreturnedAtClose: number
    contingencyReturned: number
    managerFees: number
    /** Profit share only (30% tier); `managerTotal` also counts any manager return-of-capital share. */
    managerCarry: number
    managerTotal: number
    byCadence: { annual: ReturnsBlock; quarterly?: ReturnsBlock; monthly?: ReturnsBlock }
  }
}

/** `assets: 'register'` was asked for, but there is no register to read yet (P1b). */
export class FleetRegisterUnavailableError extends Error {
  readonly code = 'fleet_register_unavailable'
  constructor() {
    super('These assumptions use the asset register, and no register was supplied.')
    this.name = 'FleetRegisterUnavailableError'
  }
}

/** The assumptions cannot be run as given. */
export class ScenarioInputError extends Error {
  readonly code = 'scenario_input'
  constructor(message: string) {
    super(message)
    this.name = 'ScenarioInputError'
  }
}

/** The fleet a scenario runs on: the planned one, or the register (P1b supplies it; null until then). */
export function resolveFleet(a: FleetAssumptions, register: PlannedAsset[] | null): PlannedAsset[] {
  if (a.assets !== 'register') return a.assets
  if (register == null) throw new FleetRegisterUnavailableError()
  return register
}

/** Single synthetic investor: the scenario is vehicle-level, the tiers never depend on headcount. */
const INVESTORS = 'investors'

const cents = (n: number) => Math.round(roundCents(n) * 100)
const dollars = (c: number) => roundCents(c / 100)
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)

/** `anchor × Π_{k<y}(1+g_k) × (1 + timing·g_y)`, y 1-based (plan §5.2). */
function rateOf(a: FleetAssumptions, typeCode: string, year: number): number {
  const { anchorRate, priceChanges } = a.types[typeCode]
  let rate = anchorRate
  for (let k = 0; k < year - 1; k++) rate *= 1 + priceChanges[k]
  return rate * (1 + a.priceChangeTiming * priceChanges[year - 1])
}

function utilizationOf(a: FleetAssumptions, typeCode: string, year: number): number {
  return typeof a.utilization === 'number' ? a.utilization : a.utilization[typeCode][year - 1]
}

function validate(a: FleetAssumptions, fleet: PlannedAsset[]): void {
  const fail = (m: string) => { throw new ScenarioInputError(m) }
  if (a.version !== 1) fail(`Unknown fleet assumptions version ${String(a.version)}.`)
  if (!isMonthKey(a.startMonth)) fail(`Start month must be YYYY-MM (got ${a.startMonth}).`)
  if (!(Number.isInteger(a.saleYear) && a.saleYear >= 1 && a.saleYear <= a.years)) {
    fail(`The sale year must be a whole year between 1 and ${a.years}.`)
  }
  const returnYear = a.capex.returnYear ?? a.saleYear
  if (!(Number.isInteger(returnYear) && returnYear >= 1 && returnYear <= a.saleYear)) {
    fail(`The contingency return year must be between 1 and the sale year (${a.saleYear}).`)
  }
  if (!(a.lifeYears > 0)) fail('The hardware life must be above 0 years.')
  if (fleet.length === 0) fail('The fleet has no assets.')
  for (const asset of fleet) {
    const type = a.types[asset.typeCode]
    if (!type) fail(`No price path for server type ${asset.typeCode}.`)
    if (type.priceChanges.length < a.saleYear) fail(`The ${asset.typeCode} price path is shorter than ${a.saleYear} years.`)
    if (typeof a.utilization !== 'number' && !((a.utilization[asset.typeCode]?.length ?? 0) >= a.saleYear)) {
      fail(`No ${a.saleYear}-year utilization for server type ${asset.typeCode}.`)
    }
  }
}

/**
 * R8 pre-step: pay `amountCents` of unspent contingency to investors as capital, before the tiers.
 * Pro rata by contributed, each share capped at that investor's unreturned capital; what the cap
 * leaves falls into the normal tiers of the same period. The state must already be accrued to the
 * period end, so the period's pref is earned on the capital outstanding during it.
 *
 * gpu-P2's PR B adds `distribute(…, { contingencyReturn })` for the actuals path; B1 switches this
 * file to it and deletes the pre-step. Until then it lives here so `waterfall.ts` is untouched.
 */
function returnContingency(state: CashWaterfallState, amountCents: number): { state: CashWaterfallState; returned: number } {
  const unreturned = state.investors.map(i => cents(i.unreturned))
  const capped = Math.min(amountCents, sum(unreturned))
  if (capped <= 0) return { state, returned: 0 }
  const shares = apportionCents(capped, state.investors.map(i => cents(i.contributed)))
    .map((s, k) => Math.min(s, unreturned[k]))
  const investors = state.investors.map((i, k) => ({ ...i, unreturned: dollars(unreturned[k] - shares[k]) }))
  return { state: { ...state, investors }, returned: sum(shares) }
}

/** Per year, in cents: the cash the waterfall sees, split into its parts so periods can place them. */
interface YearCash {
  /** Operating profit − fee: spread evenly over the year's periods. */
  operating: number
  /** Last period of the sale year. */
  sale: number
  /** First period of the return year. */
  contingency: number
}

/** Each year's cash in `n` periods: operating evenly, sale in the last, contingency in the first. */
function periodAmounts(y: YearCash, n: number): { amount: number; contingency: number }[] {
  const parts = apportionCents(y.operating, Array(n).fill(1))
  return parts.map((p, k) => ({
    amount: p + (k === n - 1 ? y.sale : 0) + (k === 0 ? y.contingency : 0),
    contingency: k === 0 ? y.contingency : 0,
  }))
}

function runCadence(
  cadence: Cadence,
  a: FleetAssumptions,
  capitalCents: number,
  investorCash: YearCash[],
  projectCash: YearCash[],
  terms: CashWaterfallTerms,
): ReturnsBlock {
  const n = PERIODS_PER_YEAR[cadence]
  const months = 12 / n
  const start = firstDay(a.startMonth)
  let state = contribute(emptyState(start), { kind: 'contribution', date: start, lpEntityId: INVESTORS, amount: dollars(capitalCents) })
  const periods: PeriodRow[] = []
  const projectFlows = [{ t: 0, amount: -dollars(capitalCents) }]

  investorCash.forEach((yc, yi) => {
    const project = periodAmounts(projectCash[yi], n)
    periodAmounts(yc, n).forEach((p, k) => {
      const period = yi * n + k + 1
      const t = period / n
      const date = lastDay(addMonths(a.startMonth, period * months - 1))
      if (p.amount < 0) {
        throw new ScenarioInputError(`Year ${yi + 1} has negative distributable cash; this model has no reserve or capital call to fund it.`)
      }
      const unreturnedStart = roundCents(sum(state.investors.map(i => i.unreturned)))
      const accrued = accrue(state, date, terms, 1 / n)
      const { state: afterReturn, returned } = returnContingency(accrued, p.contingency)
      const d = distribute(afterReturn, dollars(p.amount - returned), date, terms, 0)
      state = d.state
      periods.push({
        period, year: yi + 1, t, date,
        distributable: dollars(p.amount),
        unreturnedStart,
        contingencyReturn: dollars(returned),
        preferred: d.tiers.preferred,
        prefCarriedForward: d.tiers.prefCarriedForward,
        returnOfCapital: d.tiers.returnOfCapital,
        managerRocShare: d.tiers.managerRocShare,
        profitToLP: d.tiers.profitToLP,
        carry: d.tiers.carry,
        toInvestors: dollars(returned + cents(d.tiers.toLP)),
        toManager: d.tiers.toGP,
        unreturnedAfter: d.tiers.unreturnedAfter,
      })
      projectFlows.push({ t, amount: dollars(project[k].amount) })
    })
  })

  const capital = dollars(capitalCents)
  const flows = [{ t: 0, amount: -capital }, ...periods.map(p => ({ t: p.t, amount: p.toInvestors }))]
  const total = dollars(sum(periods.map(p => cents(p.toInvestors))))
  const projectTotal = sum(projectFlows.slice(1).map(f => f.amount))
  return {
    cadence,
    label: CADENCE_LABELS[cadence],
    investor: { irr: irrOf(flows), multiple: total / capital, total },
    project: { irr: irrOf(projectFlows), multiple: projectTotal / capital },
    flows,
    periods,
  }
}

/** Run one scenario (plan §5.2). Pure: the same assumptions always give the same tables. */
export function runFleetScenario(a: FleetAssumptions, fleet: PlannedAsset[], terms: ScenarioTerms): FleetScenarioResult {
  validate(a, fleet)
  const cadence = a.cadence ?? DEFAULT_CADENCE
  const feeRate = a.overrides?.feeRate ?? terms.feeRate
  const waterfallTerms: CashWaterfallTerms = {
    ...terms.waterfall,
    prefRate: a.overrides?.prefRate ?? terms.waterfall.prefRate,
    carryRate: a.overrides?.carryRate ?? terms.waterfall.carryRate,
    rocLpShare: a.overrides?.rocLpShare ?? terms.waterfall.rocLpShare,
    dayCount: 'periodic',
  }
  // `distribute` trusts its terms, so the merged ones are checked here: a carry of 2 would
  // otherwise run and pay investors negative profit.
  const termsError = validateCashTerms(waterfallTerms)
  if (termsError) throw new ScenarioInputError(termsError)
  if (!(feeRate >= 0 && feeRate < 1)) throw new ScenarioInputError('The management fee must be a fraction between 0 and 1 (0.05 = 5%).')

  const hardware = sum(fleet.map(f => f.servers * f.hardwareCost))
  const basis = hardware + sum(fleet.map(f => f.servers * (f.capitalizedCosts ?? 0)))
  const salvage = a.salvagePct * hardware
  const yearlyDepreciation = (basis - salvage) / a.lifeYears
  const capitalCents = cents(hardware * (1 + a.capex.contingencyPct))
  const returnYear = a.capex.returnYear ?? a.saleYear
  const unspentCents = a.capex.contingencySpent == null
    ? 0
    : Math.max(0, cents(hardware * a.capex.contingencyPct - a.capex.contingencySpent))

  const typeCodes = [...new Set(fleet.map(f => f.typeCode))]
  const rates = Object.fromEntries(typeCodes.map(t => [
    t, Array.from({ length: a.saleYear }, (_, k) => rateOf(a, t, k + 1)),
  ]))

  const operating: OperatingRow[] = [{
    year: 0, revenueByType: Object.fromEntries(typeCodes.map(t => [t, 0])), revenue: 0, datacenter: 0,
    processing: 0, insurance: 0, contingency: 0, expenses: 0, operatingProfit: 0, saleProceeds: 0,
    unspentContingency: 0, netCashFlow: -dollars(capitalCents), cumulative: -dollars(capitalCents),
    depreciation: 0, nbv: roundCents(basis),
  }]
  const fees: number[] = []
  const investorCash: YearCash[] = []
  const projectCash: YearCash[] = []
  let rented = 0
  let available = 0
  let cumulativeCents = -capitalCents
  let depreciated = 0

  for (let year = 1; year <= a.saleYear; year++) {
    const byType: Record<string, number> = Object.fromEntries(typeCodes.map(t => [t, 0]))
    for (const asset of fleet) {
      const hours = asset.servers * asset.gpusPerServer * a.hoursPerYear
      const util = utilizationOf(a, asset.typeCode, year)
      byType[asset.typeCode] += hours * util * rates[asset.typeCode][year - 1]
      rented += hours * util
      available += hours
    }
    // Everything unrounded until the row is written, as the pack computes it.
    const revenue = sum(Object.values(byType))
    const datacenter = 12 * a.datacenter.monthly
      * Math.pow(1 + a.datacenter.escalator, Math.max(0, year - a.datacenter.firstEscalationYear + 1))
    const contingency = a.datacenter.contingencyPct * datacenter
    const processing = a.processingFeePct * revenue
    const insurance = a.insurancePct * hardware
    const expenses = datacenter + contingency + processing + insurance
    const operatingProfit = revenue - expenses
    // The fee is on gross revenue only: never on sale proceeds or the contingency return.
    const fee = feeRate * revenue
    // Capped at what is left above salvage, so a fractional life (2.5 years) charges its final
    // part-year and the NBV, hence the sale at book, reaches salvage instead of stopping short.
    const depreciation = Math.max(0, Math.min(yearlyDepreciation, basis - salvage - depreciated))
    depreciated += depreciation
    const nbv = basis - depreciated
    const sale = year === a.saleYear ? cents(nbv) : 0
    const unspent = year === returnYear ? unspentCents : 0

    const toWaterfall = cents(operatingProfit - fee + dollars(sale))
    const toProject = cents(operatingProfit + dollars(sale))
    investorCash.push({ operating: toWaterfall - sale, sale, contingency: unspent })
    projectCash.push({ operating: toProject - sale, sale, contingency: unspent })
    fees.push(fee)
    cumulativeCents += toProject + unspent

    operating.push({
      year,
      revenueByType: Object.fromEntries(typeCodes.map(t => [t, roundCents(byType[t])])),
      revenue: roundCents(revenue),
      datacenter: roundCents(datacenter),
      processing: roundCents(processing),
      insurance: roundCents(insurance),
      contingency: roundCents(contingency),
      expenses: roundCents(expenses),
      operatingProfit: roundCents(operatingProfit),
      saleProceeds: dollars(sale),
      unspentContingency: dollars(unspent),
      netCashFlow: dollars(toProject + unspent),
      cumulative: dollars(cumulativeCents),
      depreciation: roundCents(depreciation),
      nbv: roundCents(nbv),
    })
  }

  const annual = runCadence('annual', a, capitalCents, investorCash, projectCash, waterfallTerms)
  const byCadence: FleetScenarioResult['returns']['byCadence'] = { annual }
  if (cadence !== 'annual') byCadence[cadence] = runCadence(cadence, a, capitalCents, investorCash, projectCash, waterfallTerms)

  const waterfall: WaterfallRow[] = annual.periods.map((p, k) => {
    const fee = roundCents(fees[k])
    return {
      year: p.year,
      fee,
      distributable: p.distributable,
      unreturnedStart: p.unreturnedStart,
      contingencyReturn: p.contingencyReturn,
      preferred: p.preferred,
      prefCarriedForward: p.prefCarriedForward,
      returnOfCapital: p.returnOfCapital,
      managerRocShare: p.managerRocShare,
      afterCapital: roundCents(p.profitToLP + p.carry),
      profitToLP: p.profitToLP,
      carry: p.carry,
      toInvestors: p.toInvestors,
      toManager: roundCents(fee + p.toManager),
    }
  })

  const recovered = operating.find(r => r.year > 0 && r.cumulative > 0)
  const managerFees = roundCents(sum(fees))
  const last = annual.periods[annual.periods.length - 1]
  return {
    cadence,
    utilization: available > 0 ? rented / available : 0,
    rates,
    operating,
    waterfall,
    returns: {
      capitalRaised: dollars(capitalCents),
      investor: { multiple: annual.investor.multiple, irr: annual.investor.irr, total: annual.investor.total },
      project: annual.project,
      capitalRecoveredYear: recovered?.year ?? null,
      unreturnedAtClose: last.unreturnedAfter,
      contingencyReturned: dollars(sum(annual.periods.map(p => cents(p.contingencyReturn)))),
      managerFees,
      managerCarry: dollars(sum(annual.periods.map(p => cents(p.carry)))),
      managerTotal: dollars(cents(managerFees) + sum(annual.periods.map(p => cents(p.toManager)))),
      byCadence,
    },
  }
}
