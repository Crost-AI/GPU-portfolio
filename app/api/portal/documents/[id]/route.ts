import { NextRequest, NextResponse } from 'next/server'
import { portalDocumentUrl } from '@/lib/portal/service'
import { portalErrorResponse, sessionPrincipal } from '@/lib/portal/session'

/**
 * LP portal — a short-lived signed URL for one document, after confirming the signed-in LP may
 * see it: the fund's portal is on AND either it's fund-wide for a fund they belong to, or it's
 * investor-scoped and shared with one of their investors.
 *
 * `?disposition=inline` returns a URL the browser renders in place (for the in-portal viewer) and
 * logs a `view` event; the default forces a download and logs a `download` event.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const s = await sessionPrincipal()
  if (s instanceof NextResponse) return s
  try {
    const inline = req.nextUrl.searchParams.get('disposition') === 'inline'
    const { url } = await portalDocumentUrl(s.admin, s.principal, params.id, { inline })
    return NextResponse.json({ url })
  } catch (e) {
    return portalErrorResponse(e, 'portal-document')
  }
}
