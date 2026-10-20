// ── GPU fleet (P5) ── The Forecast page's Fleet tab: a plan's `FleetAssumptions` (lib/gpu/scenario.ts)
// as an editable form and back, and the PATCH that saves it. Rates and shares are typed as percents
// and stored as fractions. Only what the form cannot even read is refused here; every rule about
// what makes sense (years, sale year, a type for every asset) is the route's, whose
// ScenarioInputError message the form shows as it says it.

import type { Cadence, FleetAssumptions, PlannedAsset } from '@/lib/gpu/scenario'
import { send, type Fetcher, type Result } from './fleet-api'

export interface AssetRowForm { typeCode: string; servers: string; gpusPerServer: string; hardwareCost: string; capitalizedCosts: string }
export interface TypeRowForm { code: string; anchorRate: string; priceChanges: string; utilization: string }

export interface FleetForm {
  startMonth: string
  years: string
  saleYear: string
  fromRegister: boolean
  assets: AssetRowForm[]
  hoursPerYear: string
  priceChangeTiming: string
  /** One row per GPU type: its anchor rate, price changes (percents, comma separated) and, when per type, utilization. */
  types: TypeRowForm[]
  utilizationPerType: boolean
  utilization: string
  dcMonthly: string
  dcEscalator: string
  dcFirstEscalationYear: string
  dcContingency: string
  processingFee: string
  insurance: string
  capexContingency: string
  capexSpent: string
  capexReturnYear: string
  salvage: string
  lifeYears: string
  /** '' is the vehicle's own cadence. */
  cadence: '' | Cadence
  feeRate: string
  prefRate: string
  carryRate: string
  rocLpShare: string
}

/** A fraction as a percent string without float noise: 0.07 → "7". */
export const toPct = (x: number) => String(Math.round(x * 1e8) / 1e6)
const fromPct = (n: number) => Math.round(n * 1e8) / 1e10
const s = (n: number | null | undefined) => (n == null ? '' : String(n))
const list = (xs: number[]) => xs.map(toPct).join(', ')

export function toFleetForm(f: FleetAssumptions): FleetForm {
  const util = f.utilization
  const typeCodes = Object.keys(f.types)
  return {
    startMonth: f.startMonth,
    years: s(f.years),
    saleYear: s(f.saleYear),
    fromRegister: f.assets === 'register',
    assets: f.assets === 'register' ? [] : f.assets.map(a => ({
      typeCode: a.typeCode, servers: s(a.servers), gpusPerServer: s(a.gpusPerServer), hardwareCost: s(a.hardwareCost), capitalizedCosts: s(a.capitalizedCosts),
    })),
    hoursPerYear: s(f.hoursPerYear),
    priceChangeTiming: toPct(f.priceChangeTiming),
    types: typeCodes.map(code => ({
      code, anchorRate: s(f.types[code].anchorRate), priceChanges: list(f.types[code].priceChanges),
      utilization: typeof util === 'number' ? '' : list(util[code] ?? []),
    })),
    utilizationPerType: typeof util !== 'number',
    utilization: typeof util === 'number' ? toPct(util) : '',
    dcMonthly: s(f.datacenter.monthly),
    dcEscalator: toPct(f.datacenter.escalator),
    dcFirstEscalationYear: s(f.datacenter.firstEscalationYear),
    dcContingency: toPct(f.datacenter.contingencyPct),
    processingFee: toPct(f.processingFeePct),
    insurance: toPct(f.insurancePct),
    capexContingency: toPct(f.capex.contingencyPct),
    capexSpent: s(f.capex.contingencySpent),
    capexReturnYear: s(f.capex.returnYear),
    salvage: toPct(f.salvagePct),
    lifeYears: s(f.lifeYears),
    cadence: f.cadence ?? '',
    feeRate: f.overrides?.feeRate == null ? '' : toPct(f.overrides.feeRate),
    prefRate: f.overrides?.prefRate == null ? '' : toPct(f.overrides.prefRate),
    carryRate: f.overrides?.carryRate == null ? '' : toPct(f.overrides.carryRate),
    rocLpShare: f.overrides?.rocLpShare == null ? '' : toPct(f.overrides.rocLpShare),
  }
}

class FormError extends Error {}

/** A required number; a typed amount may carry dollar signs and commas. */
function num(v: string, label: string): number {
  const n = Number(v.replace(/[$,\s]/g, ''))
  if (v.trim() === '' || !Number.isFinite(n)) throw new FormError(`${label} must be a number.`)
  return n
}
const pct = (v: string, label: string) => fromPct(num(v, label))
const optional = <T>(v: string, f: (v: string) => T): T | undefined => (v.trim() === '' ? undefined : f(v))
const pctList = (v: string, label: string) => v.split(',').map(x => x.trim()).filter(Boolean).map(x => pct(x, label))

/** The form as FleetAssumptions, or the first field the form cannot read. */
export function fromFleetForm(f: FleetForm): { fleet: FleetAssumptions } | { error: string } {
  try {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(f.startMonth)) throw new FormError('Start month must be YYYY-MM.')
    const assets: 'register' | PlannedAsset[] = f.fromRegister ? 'register' : f.assets.map((a, i) => {
      const n = `Asset ${i + 1}`
      if (!a.typeCode.trim()) throw new FormError(`${n}: enter its GPU type code.`)
      const capitalized = optional(a.capitalizedCosts, v => num(v, `${n} capitalized costs`))
      return {
        typeCode: a.typeCode.trim(), servers: num(a.servers, `${n} servers`), gpusPerServer: num(a.gpusPerServer, `${n} GPUs per server`),
        hardwareCost: num(a.hardwareCost, `${n} hardware cost`), ...(capitalized === undefined ? {} : { capitalizedCosts: capitalized }),
      }
    })
    const types = Object.fromEntries(f.types.map((t, i) => {
      if (!t.code.trim()) throw new FormError(`GPU type ${i + 1}: enter its code.`)
      return [t.code.trim(), { anchorRate: num(t.anchorRate, `${t.code} anchor rate`), priceChanges: pctList(t.priceChanges, `${t.code} price changes`) }]
    }))
    const utilization = f.utilizationPerType
      ? Object.fromEntries(f.types.map(t => [t.code.trim(), pctList(t.utilization, `${t.code} utilization`)]))
      : pct(f.utilization, 'Utilization')
    const overrides = Object.fromEntries(([
      ['feeRate', f.feeRate, 'Fee rate'], ['prefRate', f.prefRate, 'Preferred return'],
      ['carryRate', f.carryRate, 'Carry rate'], ['rocLpShare', f.rocLpShare, 'Return of capital to investors'],
    ] as const).flatMap(([k, v, label]) => (v.trim() === '' ? [] : [[k, pct(v, label)]])))
    const returnYear = optional(f.capexReturnYear, v => num(v, 'Contingency return year'))
    const fleet: FleetAssumptions = {
      version: 1,
      startMonth: f.startMonth,
      years: num(f.years, 'Years'),
      saleYear: num(f.saleYear, 'Sale year'),
      assets,
      hoursPerYear: num(f.hoursPerYear, 'Hours per year'),
      priceChangeTiming: pct(f.priceChangeTiming, 'Price change timing'),
      types,
      utilization,
      datacenter: {
        monthly: num(f.dcMonthly, 'Datacenter monthly fee'), escalator: pct(f.dcEscalator, 'Datacenter escalator'),
        firstEscalationYear: num(f.dcFirstEscalationYear, 'First escalation year'), contingencyPct: pct(f.dcContingency, 'Datacenter contingency'),
      },
      processingFeePct: pct(f.processingFee, 'Processing fee'),
      insurancePct: pct(f.insurance, 'Insurance'),
      capex: {
        contingencyPct: pct(f.capexContingency, 'Capex contingency'),
        contingencySpent: f.capexSpent.trim() === '' ? null : num(f.capexSpent, 'Contingency spent'),
        ...(returnYear === undefined ? {} : { returnYear }),
      },
      salvagePct: pct(f.salvage, 'Salvage'),
      lifeYears: num(f.lifeYears, 'Life'),
      ...(f.cadence ? { cadence: f.cadence } : {}),
      ...(Object.keys(overrides).length ? { overrides } : {}),
    }
    return { fleet }
  } catch (e) {
    if (e instanceof FormError) return { error: e.message }
    throw e
  }
}

/**
 * A starting point for a plan with no fleet assumptions yet: the fleet from the register, five years
 * from next month, and the pack's operating defaults. Every figure is editable before the first save.
 */
export function blankFleet(today = new Date()): FleetAssumptions {
  const next = new Date(today.getFullYear(), today.getMonth() + 1, 1)
  return {
    version: 1,
    startMonth: `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`,
    years: 5, saleYear: 5, assets: 'register', hoursPerYear: 8760, priceChangeTiming: 0.5, types: {}, utilization: 0.75,
    datacenter: { monthly: 0, escalator: 0, firstEscalationYear: 2, contingencyPct: 0 },
    processingFeePct: 0, insurancePct: 0, capex: { contingencyPct: 0, contingencySpent: null }, salvagePct: 0.1, lifeYears: 5,
  }
}

/**
 * Save a plan's fleet assumptions whole. The revision is the one the page loaded: a 409 means someone
 * saved in between, and the caller reloads the plan and says so.
 */
export function patchFleet<T = unknown>(fetcher: Fetcher, planId: string, expectedRevision: number, fleet: FleetAssumptions): Promise<Result<T>> {
  return send<T>(fetcher, `/api/accounting/forecast/${encodeURIComponent(planId)}`, 'PATCH', { expectedRevision, fleet })
}

/** What the form says after a 409: the route's message, and that the latest assumptions are now loaded. */
export const staleMessage = (routeError: string) =>
  `${routeError} The latest assumptions have been loaded; make your change again and save.`

/**
 * The Fleet tab's save, start to finish: PATCH at the loaded revision; on a 409, reload the plan and
 * answer the stale message; on any other refusal, the route's own words. `saved` gets the recompiled
 * plan the PATCH answers with.
 */
export async function saveFleetPlan<T>(input: {
  fetcher: Fetcher
  planId: string
  revision: number
  fleet: FleetAssumptions
  reload: () => Promise<unknown>
  saved: (plan: T) => Promise<unknown> | void
}): Promise<string | null> {
  const r = await patchFleet<T>(input.fetcher, input.planId, input.revision, input.fleet)
  if (r.ok) { await input.saved(r.data); return null }
  if (r.status === 409) {
    await input.reload().catch(() => null)
    return staleMessage(r.error)
  }
  return r.error
}
