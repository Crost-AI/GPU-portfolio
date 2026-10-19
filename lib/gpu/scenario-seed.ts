// "Create pitch scenarios" (pivot plan §5.1): the model pack's six scenarios as forecast plans on a
// GPU SPV, each a rolling forecast carrying its fleet assumptions and one linked_fleet rule per flow
// on the GPU chart. Base case is the vehicle's primary plan and is published as its approved
// version, the baseline variance on actuals is measured against.
//
// Idempotent (gpu-P5 (3)): a vehicle that already has fleet plans gets them back and nothing is
// created, so pressing the button again never duplicates the scenarios.
//
// Writes go through the forecast service only (createPlan, savePlan, publishPlan), so forecast_*
// and nothing else: P4 books no journal entries.

import { createPlan, ForecastError, listPlans, publishPlan, savePlan, type ForecastServiceContext } from '@/lib/forecast/service'
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
  /** False when the vehicle already had fleet plans and they are returned as they are. */
  created: boolean
  plans: PitchPlan[]
  /** The Base case's approved version, when this call created it. */
  baseVersionId: string | null
}

/** Create the six pitch scenarios on `vehicle`, or return the fleet plans it already has. */
export async function createPitchScenarios(ctx: ForecastServiceContext, vehicle: string): Promise<PitchScenarios> {
  const existing = await fleetPlans(ctx, vehicle)
  if (existing.length) return { created: false, plans: existing, baseVersionId: null }

  let baseVersionId: string | null = null
  for (const id of PITCH_ORDER) {
    const label = PACK_SCENARIOS[id].label
    const fleet = packAssumptions(id, { cadence: 'quarterly' })
    const created = await createPlan(ctx, {
      vehicle, kind: 'rolling_forecast', name: label, scenario: label, horizonMonths: fleet.saleYear * 12, seed: { from: 'blank' },
    })
    const code = new Map(created.allAccounts.map(a => [a.code, a.id]))
    const missing = FLEET_FLOWS.filter(f => !code.has(FLEET_FLOW_ACCOUNTS[f]))
    if (missing.length) throw new ForecastError(`This vehicle's chart has no account for ${missing.join(', ')}; a GPU SPV's chart is needed for pitch scenarios`)
    // Y1 is the plan's first month, so each plan year is a fleet year.
    const saved = await savePlan(ctx, {
      vehicle: created.plan.vehicle,
      planId: created.plan.id,
      expectedRevision: created.plan.revision,
      fleet: { ...fleet, startMonth: created.window.first },
      rules: FLEET_FLOWS.map(flow => ({ accountId: code.get(FLEET_FLOW_ACCOUNTS[flow])!, method: 'linked_fleet' as const, params: { flow } })),
      ...(id === 'base' ? { patch: { isPrimary: true } } : {}),
    })
    if (id === 'base') {
      const v = await publishPlan(ctx, {
        vehicle: saved.plan.vehicle, planId: saved.plan.id, expectedRevision: saved.plan.revision, status: 'approved',
        label: 'Pitch: Base case', notes: 'The model pack’s Base case, published when the pitch scenarios were created.',
      })
      baseVersionId = v.versionId
    }
  }
  return { created: true, plans: await fleetPlans(ctx, vehicle), baseVersionId }
}

async function fleetPlans(ctx: ForecastServiceContext, vehicle: string): Promise<PitchPlan[]> {
  const { plans } = await listPlans(ctx, { vehicle })
  return plans.filter(p => p.fleet != null).map(p => ({ id: p.id, name: p.name, scenario: p.scenario, isPrimary: p.isPrimary }))
}
