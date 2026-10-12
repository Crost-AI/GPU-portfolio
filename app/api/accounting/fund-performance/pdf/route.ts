import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { rateLimit } from '@/lib/rate-limit'
import { fundPerformance } from '@/lib/accounting/fund-performance'
import { performanceParams } from '@/lib/accounting/fund-performance-params'
import { buildFundPerformanceHtml } from '@/lib/accounting/fund-performance-pdf'
import { fundCurrency } from '@/lib/accounting/currency'
import { renderHtmlToPdf } from '@/lib/lp-report-pdf'

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

  const [report, currency] = await Promise.all([
    fundPerformance(admin, gate.fundId, group, params.asOf, params.grouping),
    // A document labelled in the wrong currency is a wrong document: refuse rather than guess USD.
    fundCurrency(admin, gate.fundId).catch((e: unknown) => ({ unread: e })),
  ])
  if (typeof currency !== 'string') {
    console.error('[fund-performance-pdf] fund currency', currency.unread instanceof Error ? currency.unread.message : currency.unread)
    return NextResponse.json({ error: "The fund's currency could not be read, so the document was not built. Try again." }, { status: 500 })
  }

  const pdf = await renderHtmlToPdf(buildFundPerformanceHtml(report, { currency, generatedAt: new Date().toISOString() }))
  const filename = `fund-performance-${group}-${report.asOf}`.replace(/[^a-zA-Z0-9\-]/g, '-')
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}.pdf"`,
    },
  })
}
