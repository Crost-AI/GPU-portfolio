import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts). The middleware has already checked the caller's
// grant for this route + method; resolveGroupOr400 checks both entities.
import { assertWriteAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName, vehicleNameById } from '@/lib/accounting/vehicle-id'
import { tagPartnershipExpense } from '@/lib/accounting/receipts'
import { ACTUAL_BOOK } from '@/lib/accounting/books'

/**
 * PATCH — tag an entry as a partnership expense billed to another entity, or clear the tag.
 *   { group, entryId, rebillVehicleId: <entity id> | null, rebillAmount?: number | null }
 *
 * `group` is the entity whose books the entry is on (the one that paid); `rebillVehicleId` is the
 * fund it will be billed to on the quarterly partnership invoice. The caller needs both.
 */
export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const group = await resolveGroupOr400(admin, gate, body?.group)
  if (group instanceof NextResponse) return group
  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)
  const entryId = String(body?.entryId ?? '')
  const { data: e } = await admin.from('journal_entries' as any).select('id').eq('fund_id', gate.fundId).eq('vehicle_id', vehicleId).eq('book', ACTUAL_BOOK).eq('id', entryId).maybeSingle()
  if (!e) return NextResponse.json({ error: 'Entry not found' }, { status: 404 })

  const rebillVehicleId = typeof body?.rebillVehicleId === 'string' && body.rebillVehicleId ? body.rebillVehicleId : null
  if (rebillVehicleId) {
    const name = await vehicleNameById(admin, gate.fundId, rebillVehicleId)
    if (!name) return NextResponse.json({ error: 'That entity is not in this fund.' }, { status: 400 })
    const billed = await resolveGroupOr400(admin, gate, name)
    if (billed instanceof NextResponse) return billed
  }
  const rebillAmount = body?.rebillAmount == null || body.rebillAmount === '' ? null : Number(body.rebillAmount)
  if (rebillAmount != null && !(Number.isFinite(rebillAmount) && rebillAmount > 0)) {
    return NextResponse.json({ error: 'rebillAmount must be a positive number, or empty to bill the whole expense' }, { status: 400 })
  }

  const res = await tagPartnershipExpense(admin, gate.fundId, entryId, { rebillVehicleId, rebillAmount })
  if ('error' in res) return NextResponse.json({ error: res.error }, { status: res.status ?? 400 })
  return NextResponse.json({ ok: true })
}
