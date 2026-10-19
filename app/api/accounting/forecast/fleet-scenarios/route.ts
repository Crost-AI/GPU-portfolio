import { NextRequest, NextResponse } from 'next/server'
import { getFleetScenarios } from '@/lib/forecast/service'
import { forecastRequest, readJson } from '@/lib/forecast/http'
import { assertVehicleKind } from '@/lib/accounting/vehicle-domain'
import { createPitchScenarios } from '@/lib/gpu/scenario-seed'

// A GPU SPV's fleet scenarios (gpu-P4 B1; the gpu-P5 contract).
//
//   GET  ?group=&plan=      { results, comparison, detail, cadence, primaryPlanId, plans, warnings }
//                           results is {} when the vehicle has no fleet plans (the page offers the seed);
//                           every manager figure is null for a caller without gp_economics.
//   POST { action: 'seed' } the six pitch scenarios, or the fleet plans already there (200 either way).
//
// `accounting` (lib/access/route-domains.ts), as every forecast route; the service checks the level.
// Both verbs refuse a vehicle that is not a GPU SPV with a 404 before anything is read.

export async function GET(req: NextRequest) {
  return forecastRequest(req, 'read', async (ctx, vehicle) => {
    const refused = await assertVehicleKind(ctx.admin, ctx.fundId, vehicle, 'gpu_spv')
    if (refused) return refused
    return getFleetScenarios(ctx, { vehicle, planId: req.nextUrl.searchParams.get('plan') || null })
  })
}

export async function POST(req: NextRequest) {
  const body = await readJson(req)
  return forecastRequest(req, 'write', async (ctx, vehicle) => {
    const refused = await assertVehicleKind(ctx.admin, ctx.fundId, vehicle, 'gpu_spv')
    if (refused) return refused
    if (body.action !== 'seed') return NextResponse.json({ error: "action must be 'seed'" }, { status: 400 })
    return createPitchScenarios(ctx, vehicle)
  }, body.group ?? null)
}
