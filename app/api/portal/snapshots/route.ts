import { NextResponse } from 'next/server'
import { portalStatementFunds } from '@/lib/portal/service'
import { portalErrorResponse, sessionPrincipal } from '@/lib/portal/session'

/**
 * LP portal — the signed-in LP's statements. Frozen snapshots are retired: this returns the LIVE
 * capital statement (always current) for each enabled fund whose live report is published to the
 * LP. Scoped strictly to their investor rows via resolveLpAccess; never consults fund_members.
 */
export async function GET() {
  const s = await sessionPrincipal()
  if (s instanceof NextResponse) return s
  try {
    const fundIds = await portalStatementFunds(s.admin, s.principal)
    const snapshots = fundIds.map(fundId => ({
      id: `live:${fundId}`,
      name: 'Capital Statement',
      as_of_date: null as string | null,
      shared_at: '',
      last_viewed_at: null as string | null,
      viewHref: '/portal/overview' as string | null,
      pdfUrl: `/api/portal/statement/pdf?fund=${fundId}` as string | null,
    }))
    return NextResponse.json({ snapshots })
  } catch (e) {
    return portalErrorResponse(e, 'portal-snapshots')
  }
}
