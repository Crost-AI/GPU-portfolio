import { NextResponse } from 'next/server'
import { portalMessages } from '@/lib/portal/service'
import { portalErrorResponse, sessionPrincipal } from '@/lib/portal/session'

/**
 * LP portal — the signed-in LP's conversation with their fund: what they sent from the Contact
 * form, the fund's replies, and announcements addressed to their investors. Scoped strictly to
 * the investors resolveLpAccess grants, for funds whose portal is on.
 */
export async function GET() {
  const s = await sessionPrincipal()
  if (s instanceof NextResponse) return s
  try {
    return NextResponse.json({ messages: await portalMessages(s.admin, s.principal) })
  } catch (e) {
    return portalErrorResponse(e, 'portal-messages')
  }
}
