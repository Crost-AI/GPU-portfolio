import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// lp_relations domain (lib/access/route-domains.ts), as the publish route it previews.
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { callNoticePreviewPdf } from '@/lib/accounting/notice-preview'

export const runtime = 'nodejs'
export const maxDuration = 60

// GET ?group=&id=&lp= — one partner's notice for an issued capital call, exactly as publishing
// would render it but marked DRAFT, and filed nowhere. What an approver opens from the Approvals
// card before confirming that notices go out.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  const sp = req.nextUrl.searchParams
  const out = await callNoticePreviewPdf(admin, { fundId: gate.fundId, group }, sp.get('id') ?? '', sp.get('lp') ?? '')
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status })
  return new NextResponse(new Uint8Array(out.value.pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${out.value.fileName.replace(/"/g, '')}"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
