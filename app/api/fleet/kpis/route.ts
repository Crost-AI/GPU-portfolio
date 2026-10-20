import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// fleet domain (lib/access/route-domains.ts). The middleware has already checked the grant.
import { fleetRequest } from '@/lib/gpu/ops/http'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { loadFleetKpis } from '@/lib/gpu/kpis-load'

export const runtime = 'nodejs'

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

// GET ?group=&month=YYYY-MM — `{ month, fleet, byType, byAsset, ltm }` from the register and the
// entered operations (staged and posted; `includesStaged` says when staged rows count).
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const params = req.nextUrl.searchParams
  const ctx = await fleetRequest(admin, user.id, 'read', params.get('group'))
  if (ctx instanceof NextResponse) return ctx
  const month = params.get('month') ?? new Date().toISOString().slice(0, 7)
  if (!MONTH.test(month)) return NextResponse.json({ error: 'month must be YYYY-MM' }, { status: 400 })

  const vehicleId = await vehicleIdByName(admin, ctx.gate.fundId, ctx.group)
  return NextResponse.json(await loadFleetKpis(admin, ctx.gate.fundId, vehicleId!, month))
}
