import { ensurePrimaryPlan } from '@/lib/forecast/service'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { VehicleResolutionError } from '@/lib/accounting/vehicle-resolver'
import {
  getConstructionModel,
  updateConstructionAssumptions,
} from '@/lib/accounting/construction-service'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { loadAccessContext } from '@/lib/access/effective'

// Legacy web transport. Authentication, authorization, and its existing response contract stay
// here; all construction loading, mapping, calculation, validation, and persistence are shared.

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  // Resolve (and check) the entity here: it must be one of the caller's.
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  try {
    const model = await getConstructionModel(
      { admin, fundId: gate.fundId, access: await loadAccessContext(admin, gate.fundId, gate.userId, gate.role) },
      { vehicle: group, planId: req.nextUrl.searchParams.get('plan') },
    )
    return NextResponse.json({
      plan: model.plan ?? null,
      group: model.vehicle,
      vehicleId: model.vehicleId,
      actuals: model.actuals,
      assumptions: model.assumptions,
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed' },
      { status: error instanceof VehicleResolutionError ? 400 : 500 },
    )
  }
}

export async function PUT(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const body = await req.json().catch(() => null)
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group
  try {
    const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
    // Onto a plan (plans/plan-unified-plan.md): the one asked for, else the entity's primary —
    // made if it has none yet. If no plan can be made, the service keeps the seed row instead.
    const planId = req.nextUrl.searchParams.get('plan')
      ?? await ensurePrimaryPlan({ admin, fundId: gate.fundId, userId: gate.userId, access }, group).catch(() => null)
    const model = await updateConstructionAssumptions(
      { admin, fundId: gate.fundId, access },
      { vehicle: group, assumptions: body, planId },
    )
    return NextResponse.json({ assumptions: model.assumptions })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed'
    const invalid = error instanceof VehicleResolutionError
      || message.startsWith('Invalid portfolio-construction assumption:')
      || message.includes('has no registry row')
    return NextResponse.json({ error: message }, { status: invalid ? 400 : 500 })
  }
}
