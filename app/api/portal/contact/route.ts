import { NextRequest, NextResponse } from 'next/server'
import { sendPortalMessage } from '@/lib/portal/service'
import { portalErrorResponse, sessionPrincipal } from '@/lib/portal/session'

/**
 * LP portal "Contact / ask a question" submission. Records the message and emails the fund's
 * admins (best-effort). LP-only; scoped to the LP's fund.
 */
export async function POST(req: NextRequest) {
  const s = await sessionPrincipal()
  if (s instanceof NextResponse) return s
  const body = await req.json().catch(() => ({}))
  try {
    return NextResponse.json(await sendPortalMessage(s.admin, s.principal, body))
  } catch (e) {
    return portalErrorResponse(e, 'portal-contact')
  }
}
