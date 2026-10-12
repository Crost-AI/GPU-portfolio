import { NextRequest, NextResponse } from 'next/server'
import { generateLiveInvestorReportPdf } from '@/lib/lp-report-pdf'
import { logLpAccessEvent } from '@/lib/lp-access-log'
import { portalStatementInvestors } from '@/lib/portal/service'
import { portalErrorResponse, sessionPrincipal } from '@/lib/portal/session'

export const maxDuration = 120

/**
 * LP portal — the signed-in LP's LIVE capital statement as a PDF (derived, as of today), for a
 * fund whose live report has been published to them (lp_live_report_shares) and whose portal is
 * on. Scoped strictly to their own investors.
 *
 *   GET ?fund=<fundId>
 */
export async function GET(req: NextRequest) {
  const s = await sessionPrincipal()
  if (s instanceof NextResponse) return s
  const fundId = req.nextUrl.searchParams.get('fund') ?? ''
  if (!fundId) return NextResponse.json({ error: 'fund is required' }, { status: 400 })

  let investorIds: string[]
  try {
    investorIds = await portalStatementInvestors(s.admin, s.principal, fundId)
  } catch (e) {
    return portalErrorResponse(e, 'portal-statement')
  }
  const result = await generateLiveInvestorReportPdf(s.admin, { fundId, investorIds })
  if (!result) return NextResponse.json({ error: 'No statement data' }, { status: 404 })

  await logLpAccessEvent(s.admin, {
    fundId, lpAccountId: s.principal.lpAccountId, authUserId: s.principal.userId, lpInvestorId: investorIds[0] ?? null,
    eventType: 'download', targetType: 'snapshot', targetTitle: result.fileName, metadata: { investor_ids: investorIds, format: 'pdf', live: true },
  })

  return new NextResponse(new Uint8Array(result.pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${result.fileName}"`,
    },
  })
}
