import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveLpAccess } from '@/lib/api-helpers'
import { logLpAccessEvent } from '@/lib/lp-access-log'
import { generateLetterPdf } from '@/lib/lp-report-pdf'
import { PortalError, portalLetterShare } from '@/lib/portal/service'

export const maxDuration = 120

/**
 * LP portal — download a shared LP letter as a PDF. Isolation mirrors the letter
 * web view: the letter must be shared with one of the signed-in LP's investors,
 * the fund's portal must be on, and the letter must not be mid-generation.
 */
export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const access = await resolveLpAccess(admin, user.id)
  if (access instanceof NextResponse) return access
  const { investorIds, lpAccountId } = access
  const letterId = params.id
  let share: { fundId: string; sharedInvestorIds: string[] }
  try {
    share = await portalLetterShare(admin, { userId: user.id, lpAccountId, investorIds }, letterId)
  } catch (e) {
    if (e instanceof PortalError) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    throw e
  }
  const { fundId, sharedInvestorIds } = share

  const result = await generateLetterPdf(admin, { fundId, letterId })
  if (!result) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await logLpAccessEvent(admin, {
    fundId,
    lpAccountId,
    authUserId: user.id,
    lpInvestorId: sharedInvestorIds[0] ?? null,
    eventType: 'download',
    targetType: 'letter',
    targetId: letterId,
    targetTitle: result.fileName,
    metadata: { investor_ids: sharedInvestorIds, format: 'pdf' },
  })

  return new NextResponse(new Uint8Array(result.pdf), {
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${result.fileName}"` },
  })
}
