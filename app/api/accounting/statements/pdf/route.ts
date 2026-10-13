import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { rateLimit } from '@/lib/rate-limit'
import { DocumentBuildError, financialStatementsDocument } from '@/lib/reports/documents'

export const runtime = 'nodejs'
export const maxDuration = 120

// GET — the statement package as a PDF. Same params, same gating, and the SAME computed
// package as /api/accounting/statements; this route only changes the serialization.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  // Rendering launches a browser; cap it like the other PDF routes.
  const limited = await rateLimit({ key: `statements-pdf:${user.id}`, limit: 20, windowSeconds: 300 })
  if (limited) return limited

  let doc
  try {
    doc = await financialStatementsDocument(admin, gate.fundId, group, req.nextUrl.searchParams)
  } catch (e) {
    if (e instanceof DocumentBuildError) return NextResponse.json({ error: e.message }, { status: 500 })
    throw e
  }
  return new NextResponse(new Uint8Array(doc.body), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${doc.fileName}"`,
    },
  })
}
