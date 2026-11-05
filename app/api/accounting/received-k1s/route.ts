import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { loadK1Dependencies } from '@/lib/tax/year-close'
import { markReceivedK1, RECEIVED_K1_STATUSES } from '@/lib/tax/mark-received-k1'
import { outcomeResponse } from '@/lib/service-outcome'
import { assertVehicleVisible } from '@/lib/accounting/vehicle-visibility'
import { loadAccessContext } from '@/lib/access/effective'
import { refuseGpuSpvTax } from '@/lib/accounting/vehicle-domain'

// K-1s owed to us by the funds we hold.
//
// The EXPECTATION is derived from the holdings — every fund holding files a partnership return —
// so a newly added fund appears in the chase list without anyone remembering to add it. What is
// stored here is only the departure from that: it arrived, it was amended, or it is not owed.

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group
  const gpuTax = await refuseGpuSpvTax(admin, gate.fundId, { group })
  if (gpuTax) return gpuTax
  const taxYear = Number(req.nextUrl.searchParams.get('taxYear'))
  if (!Number.isInteger(taxYear)) {
    return NextResponse.json({ error: 'A four-digit taxYear is required' }, { status: 400 })
  }

  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)
  if (!vehicleId) return NextResponse.json({ error: `Unknown vehicle "${group}"` }, { status: 400 })

  return NextResponse.json(await loadK1Dependencies(admin, gate.fundId, vehicleId, taxYear))
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  if (typeof body?.companyId !== 'string' || !body.companyId || !Number.isInteger(Number(body?.taxYear))) {
    return NextResponse.json({ error: 'companyId and taxYear are required' }, { status: 400 })
  }
  if (!(RECEIVED_K1_STATUSES as readonly string[]).includes(body?.status)) {
    return NextResponse.json({ error: `status must be one of ${RECEIVED_K1_STATUSES.join(', ')}` }, { status: 400 })
  }

  const group = typeof body?.group === 'string' ? body.group : null
  // Only into one of the caller's entities.
  if (group) {
    const hidden = await assertVehicleVisible(admin, gate, group)
    if (hidden) return hidden
    const gpuTax = await refuseGpuSpvTax(admin, gate.fundId, { group })
    if (gpuTax) return gpuTax
  } else {
    const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
    if (!access.vehicles.all) return NextResponse.json({ error: 'Choose which of your entities received this K-1.' }, { status: 403 })
  }
  const vehicleId = group ? await vehicleIdByName(admin, gate.fundId, group) : null

  // The holding check and the write: lib/tax/mark-received-k1.ts, shared with mark_holding_k_one.
  return outcomeResponse(await markReceivedK1(admin, gate.fundId, user.id, vehicleId, body))
}
