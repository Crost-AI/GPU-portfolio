import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// portfolio domain, investments feature (lib/access/route-domains.ts).
import { assertWriteAccess } from '@/lib/api-helpers'
import { refuseFleetCompany } from '@/lib/access/fleet-company'
import { loadAccessContext } from '@/lib/access/effective'
import { loadEntityScope } from '@/lib/access/entity-scope'
import { resolveHoldingVehicle } from '@/lib/portfolio/fof-register'
import { recalculateFundDistributions } from '@/lib/portfolio/fund-register-write'
import { outcomeResponse } from '@/lib/service-outcome'

// POST — work out every distribution's return of capital on one entity again by cost recovery and
// re-book the ones that differ. Shared with the recalculate_fund_distributions tool.
// { vehicleId?, dryRun? }
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  // ── GPU fleet (P3) ── A fleet company is not found to a caller without fleet write (#91), rather than
  // named in the not-a-fund-holding refusal below.
  const fleetDenied = await refuseFleetCompany(admin, user.id, { companyId: params.id }, 'write')
  if (fleetDenied) return fleetDenied

  const body = await req.json().catch(() => ({}))
  const resolved = await resolveHoldingVehicle(admin, gate.fundId, params.id, body?.vehicleId,
    await loadAccessContext(admin, gate.fundId, gate.userId, gate.role))
  if ('error' in resolved) return NextResponse.json({ error: resolved.error }, { status: 400 })

  const scope = await loadEntityScope(admin, gate)
  const result = await recalculateFundDistributions(
    admin, { fundId: gate.fundId, userId: user.id, vehicleNames: scope.vehicleNames },
    params.id, resolved.vehicleId, { dryRun: body?.dryRun === true },
  )
  return outcomeResponse(result, v => v)
}
