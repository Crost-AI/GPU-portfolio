import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// lp_capital domain (lib/access/route-domains.ts): the preview shows one partner's proposed call.
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { proposedNoticePdf } from '@/lib/accounting/proposed-call-publish'

export const runtime = 'nodejs'
export const maxDuration = 60

// GET ?group=&id=&lp= — one partner's notice as the proposal stands, marked DRAFT.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  const out = await proposedNoticePdf(admin, { fundId: gate.fundId, group, userId: user.id }, req.nextUrl.searchParams.get('id') ?? '', req.nextUrl.searchParams.get('lp') ?? '')
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status })
  return new NextResponse(new Uint8Array(out.value.pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${out.value.fileName.replace(/"/g, '')}"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
