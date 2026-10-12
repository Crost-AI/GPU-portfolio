import { NextResponse } from 'next/server'
import { portalOverview } from '@/lib/portal/service'
import { portalErrorResponse, sessionPrincipal } from '@/lib/portal/session'

/**
 * LP portal — the signed-in LP's portfolio overview: headline totals and a per-vehicle breakdown
 * from the live report the fund has published to them. Scoped strictly to the investors
 * resolveLpAccess grants, and only for funds whose LP portal is switched on. The logic is shared
 * with the investor connector (lib/portal/service.ts).
 */
export async function GET() {
  const s = await sessionPrincipal()
  if (s instanceof NextResponse) return s
  try {
    return NextResponse.json(await portalOverview(s.admin, s.principal))
  } catch (e) {
    return portalErrorResponse(e, 'portal-overview')
  }
}
