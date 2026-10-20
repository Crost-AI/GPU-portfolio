// "Create pitch scenarios" (pivot plan §5.1): the model pack's six scenarios as forecast plans on a
// GPU SPV, each a rolling forecast carrying its fleet assumptions and one linked_fleet rule per flow
// on the GPU chart. Base case is the vehicle's primary plan and is published as its approved
// version, the baseline variance on actuals is measured against.
//
// Idempotent (gpu-P5 (3)): a scenario that is done is left as it is, a missing one is created and a
// half-made one (its rules or Base's approved version not saved) is finished on the plan that is
// there, so pressing the button again never duplicates or overwrites a scenario. Two requests at
// the same moment can still both create (no database guard yet, #102).
//
// Writes go through the forecast service only (createPlan, savePlan, publishPlan), so forecast_*
// and nothing else: P4 books no journal entries.

import { createPlan, ForecastError, getPlan, listPlans, publishPlan, savePlan, type ForecastServiceContext } from '@/lib/forecast/service'
import type { FleetFlow } from '@/lib/forecast/rules'
import { FLEET_FLOWS } from '@/lib/forecast/rules'
import { PACK_SCENARIOS, type PackScenarioId } from './fixtures/pack-v3'
import { packAssumptions } from './fixtures/pack-v3-fleet'

/** The GPU chart account (lib/accounting/chart.ts GPU_SPV_CHART) each fleet flow compiles to. */
export const FLEET_FLOW_ACCOUNTS: Record<FleetFlow, string> = {
  revenue: '4000',
  processing_fee: '5150',
  datacenter: '5100',
  // The chart has no line of its own for the datacenter contingency.
  contingency: '5900',
  insurance: '5200',
  depreciation: '5300',
  disposal: '4500',
  fee: '5000',
}

/** Base case first: it becomes the primary plan. */
export const PITCH_ORDER: PackScenarioId[] = ['base', 'balanced', 'demand_led', 'oversupply', 'oversupply_60', 'oversupply_50']

export interface PitchPlan { id: string; name: string; scenario: string | null; isPrimary: boolean }

export interface PitchScenarios {
  /** False when every scenario was done: the vehicle's fleet plans are returned as they are. */
  created: boolean
  plans: PitchPlan[]
  /** The Base case's approved version, when this call created it. */
  baseVersionId: string | null
}

/**
 * Create the six pitch scenarios on `vehicle`, or finish the ones a stopped run left half-done.
 * A scenario is DONE when its plan exists (by name, with a fleet) and holds its linked_fleet rules;
 * Base is done when it also has its approved version. A missing rule is added only on an account that
 * has no rule at all, so a scenario someone has edited since is never overwritten.
 */
export async function createPitchScenarios(ctx: ForecastServiceContext, vehicle: string): Promise<PitchScenarios> {
  const { plans } = await listPlans(ctx, { vehicle })
  const fleetPlansNow = plans.filter(p => p.fleet != null)
  const rules = await rulesOf(ctx, fleetPlansNow.map(p => p.id))
  let changed = false
  let baseVersionId: string | null = null

  for (const id of PITCH_ORDER) {
    const label = PACK_SCENARIOS[id].label
    const fleet = packAssumptions(id, { cadence: 'quarterly' })
    const found = fleetPlansNow.find(p => p.name === label)
    const planRules = found ? rules.filter(r => r.plan_id === found.id) : []
    const hasFlow = (f: FleetFlow) => planRules.some(r => r.method === 'linked_fleet' && r.params?.flow === f)
    const flowsMissing = FLEET_FLOWS.filter(f => !hasFlow(f))
    const approved = !!found?.versions.some(v => v.status === 'approved')
    if (found && !flowsMissing.length && (id !== 'base' || approved)) continue
    changed = true

    // Create it, or open the one a stopped run left, for its accounts and revision.
    const detail = found
      ? await getPlan(ctx, { vehicle, planId: found.id })
      : await createPlan(ctx, {
          vehicle, kind: 'rolling_forecast', name: label, scenario: label, horizonMonths: fleet.saleYear * 12, seed: { from: 'blank' },
          // Y1 is the plan's first month, so each plan year is a fleet year.
          fleet, fleetStartsAtPlan: true,
        })
    const code = new Map(detail.allAccounts.map(a => [a.code, a.id]))
    const noAccount = FLEET_FLOWS.filter(f => !code.has(FLEET_FLOW_ACCOUNTS[f]))
    if (noAccount.length) throw new ForecastError(`This vehicle's chart has no account for ${noAccount.join(', ')}; a GPU SPV's chart is needed for pitch scenarios`)
    const ruled = new Set(detail.rules.map(r => r.accountId))
    const add = FLEET_FLOWS.filter(f => !hasFlow(f) && !ruled.has(code.get(FLEET_FLOW_ACCOUNTS[f])!))
    let revision = detail.plan.revision
    if (add.length) {
      const saved = await savePlan(ctx, {
        vehicle: detail.plan.vehicle, planId: detail.plan.id, expectedRevision: revision,
        rules: add.map(flow => ({ accountId: code.get(FLEET_FLOW_ACCOUNTS[flow])!, method: 'linked_fleet' as const, params: { flow } })),
        ...(id === 'base' ? { patch: { isPrimary: true } } : {}),
      })
      revision = saved.plan.revision
    }
    if (id === 'base' && !detail.versions.some(v => v.status === 'approved')) {
      const v = await publishPlan(ctx, {
        vehicle: detail.plan.vehicle, planId: detail.plan.id, expectedRevision: revision, status: 'approved',
        label: 'Pitch: Base case', notes: 'The model pack’s Base case, published when the pitch scenarios were created.',
      })
      baseVersionId = v.versionId
    }
  }
  return { created: changed, plans: await fleetPlans(ctx, vehicle), baseVersionId }
}

/** The rules on these plans, read once: what tells a finished scenario from a half-made one. */
async function rulesOf(ctx: ForecastServiceContext, planIds: string[]): Promise<{ plan_id: string; account_id: string; method: string; params: any }[]> {
  if (!planIds.length) return []
  const { data, error } = await (ctx.admin as any).from('forecast_rules').select('plan_id, account_id, method, params')
    .eq('fund_id', ctx.fundId).in('plan_id', planIds)
  if (error) throw error
  return (data as any[]) ?? []
}

async function fleetPlans(ctx: ForecastServiceContext, vehicle: string): Promise<PitchPlan[]> {
  const { plans } = await listPlans(ctx, { vehicle })
  return plans.filter(p => p.fleet != null).map(p => ({ id: p.id, name: p.name, scenario: p.scenario, isPrimary: p.isPrimary }))
}
