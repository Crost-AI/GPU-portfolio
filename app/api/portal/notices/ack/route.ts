import { NextRequest, NextResponse } from 'next/server'
import { acknowledgeCapitalCall } from '@/lib/portal/service'
import { portalErrorResponse, sessionPrincipal } from '@/lib/portal/session'

/**
 * LP portal — "we've wired": the partner's acknowledgment of a capital call notice.
 *
 *   POST { lineId, wiredOn?: 'YYYY-MM-DD', reference?, note? }
 *
 * Recorded on the register line for the GP to see and for the bank matcher to use as a tiebreak.
 * It is the partner's word, not a settlement: the money is settled when the ledger says so.
 * Scoped to lines belonging to the signed-in LP's own entities, in funds with the portal on.
 */
export async function POST(req: NextRequest) {
  const s = await sessionPrincipal()
  if (s instanceof NextResponse) return s
  const body = await req.json().catch(() => ({}))
  try {
    await acknowledgeCapitalCall(s.admin, s.principal, body)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return portalErrorResponse(e, 'portal-ack')
  }
}
