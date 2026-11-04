import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// portfolio domain, investments feature (lib/access/route-domains.ts).
import { assertWriteAccess } from '@/lib/api-helpers'
import { refuseFleetCompany } from '@/lib/access/fleet-company'
import { loadEntityScope } from '@/lib/access/entity-scope'
import { noticeChangesFrom, updateFundNotice } from '@/lib/portfolio/fund-register-write'
import { outcomeResponse } from '@/lib/service-outcome'

// PATCH — correct one notice in a fund holding's register. A confirmed notice re-books the
// transaction it owns and the holding's later NAV marks. Shared with the update_fund_notice tool.
// { eventDate?, amount?, dueDate?, noticeNumber?, description?,
//   purposeInvestments?/purposeFees?/purposeExpenses? | charReturnOfCapital?/charRealizedGain?/charIncome?, recallableAmount? }
export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string; eventId: string }> }) {
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
  const scope = await loadEntityScope(admin, gate)
  const result = await updateFundNotice(
    admin,
    { fundId: gate.fundId, userId: user.id, vehicleNames: scope.vehicleNames },
    params.id, params.eventId, noticeChangesFrom(body),
  )
  return outcomeResponse(result, v => v)
}
