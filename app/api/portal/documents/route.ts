import { NextResponse } from 'next/server'
import { portalDocuments } from '@/lib/portal/service'
import { portalErrorResponse, sessionPrincipal } from '@/lib/portal/session'

/**
 * LP portal — documents visible to the signed-in LP: fund-wide docs for funds they belong to,
 * plus investor-scoped docs shared with their investors. Both gated by lp_portal_enabled.
 */
export async function GET() {
  const s = await sessionPrincipal()
  if (s instanceof NextResponse) return s
  try {
    return NextResponse.json({ documents: await portalDocuments(s.admin, s.principal) })
  } catch (e) {
    return portalErrorResponse(e, 'portal-documents')
  }
}
