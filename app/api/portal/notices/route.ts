import { NextResponse } from 'next/server'
import { portalNotices } from '@/lib/portal/service'
import { portalErrorResponse, sessionPrincipal } from '@/lib/portal/session'

/**
 * LP portal — every capital call and distribution line for the signed-in LP's entities, with its
 * status from the fund's books, the notice document once published, and their own
 * acknowledgment. Scoped strictly to the investors resolveLpAccess grants, for funds whose portal
 * is on.
 */
export async function GET() {
  const s = await sessionPrincipal()
  if (s instanceof NextResponse) return s
  try {
    return NextResponse.json({ notices: await portalNotices(s.admin, s.principal) })
  } catch (e) {
    return portalErrorResponse(e, 'portal-notices')
  }
}
