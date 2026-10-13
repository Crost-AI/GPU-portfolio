import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { lpStatement } from '@/lib/accounting/capital-calls'
import { resolvePeriod, customPeriod, type PeriodPreset } from '@/lib/accounting/statement-period'
import { vehicleLetterheadDetail } from '@/lib/vehicle-letterhead'

// GET ?lp=<lpEntityId> — one LP's capital statement: the roll-forward in three columns (statement
// period, year to date, inception to date), the commitment summary, the letterhead the PDF prints,
// and the period's transactions. Optional ?preset= / ?start=&end= scopes the period column; year to
// date runs from January 1 of the period end's year.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  const sp = req.nextUrl.searchParams
  const lp = sp.get('lp')
  if (!lp) return NextResponse.json({ error: 'lp is required' }, { status: 400 })

  const preset = sp.get('preset') as PeriodPreset | null
  const period = preset && preset !== 'custom'
    ? resolvePeriod(preset)
    : customPeriod(sp.get('start'), sp.get('end'))

  const [result, letterhead] = await Promise.all([
    lpStatement(admin, gate.fundId, group, lp, period),
    vehicleLetterheadDetail(admin, gate.fundId, group),
  ])
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 404 })
  return NextResponse.json({ ...result, period, letterhead })
}
