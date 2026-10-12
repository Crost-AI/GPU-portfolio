import { NextResponse } from 'next/server'
import { dbError } from '@/lib/api-error'
import { portalLetters } from '@/lib/portal/service'
import { sessionPrincipal } from '@/lib/portal/session'

/**
 * LP portal — list the letters shared with the signed-in LP. Scoped to their investor rows
 * (resolveLpAccess) and limited to funds whose LP portal is on.
 */
export async function GET() {
  const s = await sessionPrincipal()
  if (s instanceof NextResponse) return s
  try {
    return NextResponse.json({ letters: await portalLetters(s.admin, s.principal) })
  } catch (e) {
    return dbError(e as any, 'portal-letters')
  }
}
