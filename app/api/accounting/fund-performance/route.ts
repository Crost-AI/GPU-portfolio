import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { fundPerformance } from '@/lib/accounting/fund-performance'
import { performanceParams } from '@/lib/accounting/fund-performance-params'

// GET ?group=&asOf=&groupBy= — one vehicle's LP-only fund performance report, from the books.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  const params = performanceParams(req.nextUrl.searchParams)
  if (params instanceof NextResponse) return params

  try {
    return NextResponse.json(await fundPerformance(admin, gate.fundId, group, params.asOf, params.grouping))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed' }, { status: 500 })
  }
}
