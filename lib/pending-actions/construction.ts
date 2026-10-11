import { ensurePrimaryPlan } from '@/lib/forecast/service'
import type {
  ConstructionAssumptions,
  ConstructionPositionActual,
  ConstructionPositionForecast,
  ConstructionStage,
} from '@/lib/accounting/construction'
import {
  getConstructionModel,
  updateConstructionAssumptions,
  validateConstructionAssumptions,
} from '@/lib/accounting/construction-service'
import type { ActionDeps, PreviewResult } from './types'

type ScalarPatch = Partial<Pick<ConstructionAssumptions,
  | 'targetPortfolioSize'
  | 'targetFundMultiple'
  | 'stages'
>>

/**
 * The Analyst's edit to a plan's Investments tab (plans/plan-unified-plan.md §5): planned deals
 * (their checks, timing and exits), the exits of the companies the fund already holds, and the
 * portfolio targets. Investments and exits are entered here and nowhere else. Fees and expenses are
 * the Financials tab's (update_forecast_plan, the management_fee rule).
 */
export interface UpdatePortfolioConstructionInput extends ScalarPatch {
  vehicle: string
  /** The plan (scenario or budget) to change; omitted = the entity's primary plan. */
  planId?: string
  /** Add or change planned deals by key, leaving the others as they are. */
  upsertStages?: Partial<ConstructionStage>[]
  /** Planned deals to remove, by key. */
  removeStages?: string[]
  /** Per-company patches keyed by the stable companies.id UUID. */
  positionForecasts?: Record<string, Partial<Omit<ConstructionPositionForecast, 'companyId'>>>
  /** The fund-wide return assumptions (the page's Return assumptions dialog). */
  returnAssumptions?: {
    /** Default years from investment to exit. */
    holdYears?: number
    /** Exit multiple for a deal with none of its own. */
    defaultExitMultiple?: number
    /** Share of PLANNED deals the simulation writes off (0–0.99). */
    lossRate?: number
    /** Years either side of the expected exit the simulation varies timing. */
    exitTimingRangeYears?: number
    /** Spread of simulated outcomes (log-normal sigma). */
    dispersion?: number
  }
  explanation?: string
}

const ASSUMPTION_FIELDS = [
  'targetPortfolioSize',
  'targetFundMultiple',
  'stages',
  'upsertStages',
  'removeStages',
  'positionForecasts',
  'returnAssumptions',
] as const

/** Moved to the Financials tab; named so the refusal can say where they went. */
const FEE_FIELDS = new Set(['feeAnnualRate', 'feeBasis', 'feeTermYears', 'feeStartDate', 'feeStepDownYear', 'feeStepDownRate', 'annualPartnershipExpense', 'remainingOrgCosts'])

const TOP_LEVEL_FIELDS = new Set<string>(['vehicle', 'planId', 'explanation', ...ASSUMPTION_FIELDS])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const STAGE_FIELDS = new Set([
  'key', 'label', 'initialCheck', 'initialPostMoney', 'followOnMultiple', 'followOnCheck', 'dilutionFactor',
  'ownershipAtExit', 'additionalDilution', 'expectedExitValue', 'forecastMoic', 'forecastMoicOverride', 'returnMethod',
  'investInYears', 'exitInYears', 'followOnInYears', 'simLossRate', 'simDispersion', 'simExitSpreadYears',
])

function changedFields(
  input: UpdatePortfolioConstructionInput,
): Array<(typeof ASSUMPTION_FIELDS)[number]> {
  return ASSUMPTION_FIELDS.filter(field => input[field] !== undefined)
}

function validatePatchEnvelope(input: UpdatePortfolioConstructionInput): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Construction update must be an object')
  }
  const fees = Object.keys(input).filter(field => FEE_FIELDS.has(field))
  if (fees.length > 0) {
    throw new Error(`Fees and expenses are set on the Financials tab now, not the Investments tab — change them with update_forecast_plan (the management_fee rule, or the expense accounts' rules): ${fees.join(', ')}`)
  }
  const unknown = Object.keys(input).filter(field => !TOP_LEVEL_FIELDS.has(field))
  if (unknown.length > 0) throw new Error(`Construction updates cannot change: ${unknown.join(', ')}`)
  if (typeof input.vehicle !== 'string' || !input.vehicle.trim()) throw new Error('vehicle is required')
  if (input.planId != null && typeof input.planId !== 'string') throw new Error('planId must be a string')
  if (input.explanation != null && typeof input.explanation !== 'string') {
    throw new Error('explanation must be a string')
  }
  if (changedFields(input).length === 0) {
    throw new Error('Specify at least one construction assumption to change')
  }
}

const stageKey = (label: string, taken: Set<string>) => {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'deal'
  let k = base
  for (let n = 2; taken.has(k); n++) k = `${base}-${n}`
  return k
}

function applyPatch(
  before: ConstructionAssumptions,
  input: UpdatePortfolioConstructionInput,
  actualPositions: ConstructionPositionActual[],
  vintageYear: number | null,
): ConstructionAssumptions {
  validatePatchEnvelope(input)

  const next: ConstructionAssumptions = { ...before }
  if (input.targetPortfolioSize !== undefined) next.targetPortfolioSize = input.targetPortfolioSize
  if (input.targetFundMultiple !== undefined) next.targetFundMultiple = input.targetFundMultiple
  if (input.stages !== undefined) next.stages = input.stages

  // One deal at a time: by key, so a change to one planned deal cannot drop the others.
  if (input.upsertStages !== undefined || input.removeStages !== undefined) {
    const stages = [...next.stages]
    for (const key of input.removeStages ?? []) {
      const i = stages.findIndex(st => st.key === key)
      if (i < 0) throw new Error(`No planned deal "${key}" to remove`)
      stages.splice(i, 1)
    }
    for (const patch of input.upsertStages ?? []) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Each upsertStages item must be an object')
      const bad = Object.keys(patch).filter(f => !STAGE_FIELDS.has(f))
      if (bad.length) throw new Error(`A planned deal cannot set: ${bad.join(', ')}`)
      const i = patch.key ? stages.findIndex(st => st.key === patch.key) : -1
      if (i >= 0) {
        stages[i] = { ...stages[i], ...patch, key: stages[i].key }
        continue
      }
      if (!patch.label || patch.initialCheck == null) throw new Error('A new planned deal needs a label and an initialCheck')
      const key = patch.key ?? stageKey(patch.label, new Set(stages.map(st => st.key)))
      stages.push({
        initialPostMoney: 0, followOnMultiple: 0, dilutionFactor: 1,
        ...patch, key, label: patch.label, initialCheck: patch.initialCheck,
      } as ConstructionStage)
    }
    next.stages = stages
  }

  if (input.returnAssumptions !== undefined) {
    const r = input.returnAssumptions
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('returnAssumptions must be an object')
    const bad = Object.keys(r).filter(k => !['holdYears', 'defaultExitMultiple', 'lossRate', 'exitTimingRangeYears', 'dispersion'].includes(k))
    if (bad.length) throw new Error(`returnAssumptions cannot set: ${bad.join(', ')}`)
    const num = (v: unknown, name: string, max = Infinity) => {
      const n = Number(v)
      if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`${name} must be a number from 0${max < Infinity ? ` to ${max}` : ''}`)
      return n
    }
    if (r.holdYears != null) next.pacing = { ...next.pacing, holdYears: num(r.holdYears, 'holdYears', 30), existingHoldYears: num(r.holdYears, 'holdYears', 30) }
    const sim = { ...next.simulation }
    if (r.defaultExitMultiple != null) sim.defaultExitMultiple = num(r.defaultExitMultiple, 'defaultExitMultiple', 1000)
    if (r.lossRate != null) sim.lossRate = num(r.lossRate, 'lossRate', 0.99)
    if (r.exitTimingRangeYears != null) sim.holdSpreadYears = num(r.exitTimingRangeYears, 'exitTimingRangeYears', 20)
    if (r.dispersion != null) sim.dispersion = num(r.dispersion, 'dispersion', 5)
    next.simulation = sim
  }

  if (input.positionForecasts !== undefined) {
    if (!input.positionForecasts || typeof input.positionForecasts !== 'object' || Array.isArray(input.positionForecasts)) {
      throw new Error('positionForecasts must be an object keyed by company UUID')
    }
    const actualById = new Map(actualPositions.map(position => [position.companyId, position]))
    const forecasts = new Map(before.positionForecasts.map(forecast => [forecast.companyId, forecast]))
    for (const [companyId, patch] of Object.entries(input.positionForecasts)) {
      if (!UUID.test(companyId)) throw new Error(`Invalid company UUID in positionForecasts: ${companyId}`)
      const actual = actualById.get(companyId)
      if (!actual) throw new Error(`Company ${companyId} is not a position in this vehicle`)
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error(`positionForecasts.${companyId} must be an object`)
      }
      const allowed = new Set([
        'plannedFollowOn', 'ownershipAtExit', 'additionalDilution', 'expectedExitValue',
        'forecastMoic', 'forecastMoicOverride', 'returnMethod',
        // Per-company timing and simulation overrides; null returns a field to the fund-wide value.
        'exitInYears', 'followOnInYears', 'simLossRate', 'simDispersion', 'simExitSpreadYears',
      ])
      const unknownForecastFields = Object.keys(patch).filter(field => !allowed.has(field))
      if (unknownForecastFields.length > 0) {
        throw new Error(`positionForecasts.${companyId} cannot change: ${unknownForecastFields.join(', ')}`)
      }
      const current = forecasts.get(companyId) ?? {
        companyId,
        plannedFollowOn: 0,
        ownershipAtExit: actual.currentOwnership ?? 0,
        additionalDilution: 0,
        expectedExitValue: 0,
        forecastMoic: 0,
        returnMethod: 'ownership' as const,
      }
      forecasts.set(companyId, { ...current, ...patch, companyId })
    }
    next.positionForecasts = Array.from(forecasts.values())
  }

  return validateConstructionAssumptions(next, vintageYear)
}

/** Read current state and show only the explicitly requested before/after fields. */
export async function previewUpdatePortfolioConstruction(
  deps: ActionDeps,
  input: UpdatePortfolioConstructionInput,
): Promise<PreviewResult> {
  validatePatchEnvelope(input)
  const model = await getConstructionModel(
    { admin: deps.admin, fundId: deps.fundId, access: deps.access },
    { vehicle: input.vehicle, planId: input.planId ?? null },
  )
  const after = applyPatch(
    model.assumptions,
    input,
    model.actuals.positions ?? [],
    model.vintageYear,
  )
  const fields = changedFields(input)
  // A deal added, changed or removed shows as the planned deals before and after.
  const shown = [...new Set(fields.flatMap(f => (f === 'upsertStages' || f === 'removeStages' ? ['stages'] : f === 'returnAssumptions' ? ['pacing', 'simulation'] : [f])))] as (keyof ConstructionAssumptions)[]
  const changes = Object.fromEntries(shown.map(field => [field, {
    before: model.assumptions[field],
    after: after[field],
  }]))
  return {
    summary: `Update ${fields.length} portfolio-construction assumption${fields.length === 1 ? '' : 's'} for ${model.vehicle}${model.plan?.name ? ` (${model.plan.name})` : ''}`,
    details: {
      vehicle: model.vehicle,
      ...(model.plan ? { plan: model.plan.name } : {}),
      changes,
      ...(input.explanation ? { explanation: input.explanation } : {}),
    },
  }
}

/** Re-read live assumptions at approval time and apply the staged patch, never staged actuals. */
export async function executeUpdatePortfolioConstruction(
  deps: ActionDeps,
  input: UpdatePortfolioConstructionInput,
): Promise<Record<string, unknown>> {
  validatePatchEnvelope(input)
  const current = await getConstructionModel(
    { admin: deps.admin, fundId: deps.fundId, access: deps.access },
    { vehicle: input.vehicle, planId: input.planId ?? null },
  )
  const assumptions = applyPatch(
    current.assumptions,
    input,
    current.actuals.positions ?? [],
    current.vintageYear,
  )
  // Onto the plan named, else the entity's primary plan, made if it has none (plans/plan-unified-plan.md).
  const planId = input.planId ?? await ensurePrimaryPlan({ admin: deps.admin, fundId: deps.fundId, userId: deps.userId, access: deps.access }, current.vehicle).catch(() => null)
  const model = await updateConstructionAssumptions(
    { admin: deps.admin, fundId: deps.fundId, access: deps.access },
    { vehicle: current.vehicle, assumptions, planId },
  )
  return { model, planId }
}
