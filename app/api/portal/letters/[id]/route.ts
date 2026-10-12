import { NextRequest, NextResponse } from 'next/server'
import { portalLetter } from '@/lib/portal/service'
import { portalErrorResponse, sessionPrincipal } from '@/lib/portal/session'

/**
 * LP portal — one shared, finalized LP letter. Isolation: resolveLpAccess → the letter must be
 * shared with one of the LP's investors → the fund's portal must be on → the letter must be final.
 */
export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const s = await sessionPrincipal()
  if (s instanceof NextResponse) return s
  try {
    return NextResponse.json({ letter: await portalLetter(s.admin, s.principal, params.id) })
  } catch (e) {
    return portalErrorResponse(e, 'portal-letter')
  }
}
