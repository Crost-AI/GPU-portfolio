// The pack's six scenarios as `FleetAssumptions`, for the scenario engine's tests and (B1) the
// pitch-scenario seed. Built from `PACK_INPUTS` / `PACK_SCENARIOS`, so there is one source for the
// pack's inputs and this file only translates them.

import type { FleetAssumptions, PlannedAsset, ScenarioTerms } from '../scenario'
import { PACK_INPUTS, PACK_SCENARIOS, PACK_SERVERS, PACK_TERMS, type PackScenarioId } from './pack-v3'

/** One server of each type, 8 GPUs each: $1,305,000 of hardware. */
export const PACK_FLEET: PlannedAsset[] = PACK_SERVERS.map(s => ({
  typeCode: s,
  servers: 1,
  gpusPerServer: PACK_INPUTS.servers[s].gpus,
  hardwareCost: PACK_INPUTS.servers[s].cost,
}))

export const PACK_SCENARIO_TERMS: ScenarioTerms = { feeRate: PACK_INPUTS.feeRate, waterfall: PACK_TERMS }

/** The pack's assumptions for one scenario, on the pack's annual cadence unless patched. */
export function packAssumptions(id: PackScenarioId, patch: Partial<FleetAssumptions> = {}): FleetAssumptions {
  const p = PACK_INPUTS
  const s = PACK_SCENARIOS[id]
  return {
    version: 1,
    startMonth: '2027-01',
    years: p.years,
    saleYear: p.years,
    assets: PACK_FLEET,
    hoursPerYear: p.hoursPerYear,
    priceChangeTiming: p.midYear,
    types: Object.fromEntries(PACK_SERVERS.map(t => [t, { anchorRate: p.servers[t].anchorRate, priceChanges: s.priceChanges[t] }])),
    utilization: s.utilization,
    datacenter: { monthly: p.datacenterMonthly, escalator: p.datacenterGrowth, firstEscalationYear: 2, contingencyPct: p.contingencyRate },
    processingFeePct: p.processingRate,
    insurancePct: p.insuranceRate,
    capex: { contingencyPct: 0.1, contingencySpent: null },
    salvagePct: 0.1,
    lifeYears: 5,
    cadence: 'annual',
    ...patch,
  }
}
