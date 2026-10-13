import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { rateLimit } from '@/lib/rate-limit'
import { performanceParams } from '@/lib/accounting/fund-performance-params'
import { DocumentBuildError, fundPerformanceDocument } from '@/lib/reports/documents'

export const runtime = 'nodejs'
export const maxDuration = 120

// GET — the fund performance report as a PDF. Same params, same gating, and the SAME report as
// /api/accounting/fund-performance; this route only changes the serialization.
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

  // Rendering launches a browser; cap it like the other PDF routes.
  const limited = await rateLimit({ key: `fund-performance-pdf:${user.id}`, limit: 20, windowSeconds: 300 })
  if (limited) return limited

  let doc
  try {
    doc = await fundPerformanceDocument(admin, gate.fundId, group, params.asOf, params.grouping)
  } catch (e) {
    if (e instanceof DocumentBuildError) return NextResponse.json({ error: e.message }, { status: 500 })
    throw e
  }
  return new NextResponse(new Uint8Array(doc.body), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${doc.fileName}"`,
    },
  })
}
