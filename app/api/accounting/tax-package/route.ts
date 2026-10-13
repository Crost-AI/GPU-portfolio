import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts). The K-1 part is gated again in the handler:
// a K-1 package holds every partner's figures and the carry, so it joins the bundle only for a caller who may read both.
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { rateLimit } from '@/lib/rate-limit'
import { canReadK1s } from '@/lib/tax/access'
import { DocumentBuildError, taxPackageDocument } from '@/lib/reports/documents'

export const runtime = 'nodejs'
export const maxDuration = 120

// GET ?group=&year=YYYY — the year's tax package as one ZIP (lib/reports/documents.ts
// taxPackageDocument): workpapers, the statements as a PDF, the ledger and journal exports, and the
// finalised K-1 workbook when there is one and the caller may read it.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const sp = req.nextUrl.searchParams
  const group = await resolveGroupOr400(admin, gate, sp.get('group'))
  if (group instanceof NextResponse) return group

  const year = parseInt(sp.get('year') ?? '', 10)
  if (!Number.isInteger(year) || year < 1990 || year > 2100) {
    return NextResponse.json({ error: 'year=YYYY is required' }, { status: 400 })
  }

  // A workbook, a browser render and a zip — heavier than any other export. Cap accordingly.
  const limited = await rateLimit({ key: `tax-package:${user.id}`, limit: 10, windowSeconds: 600 })
  if (limited) return limited

  let doc
  try {
    doc = await taxPackageDocument(admin, gate.fundId, group, year, { includeK1: await canReadK1s(admin, gate, user.id) })
  } catch (e) {
    if (e instanceof DocumentBuildError) return NextResponse.json({ error: e.message }, { status: 500 })
    throw e
  }

  return new NextResponse(new Uint8Array(doc.body), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${doc.fileName}"`,
    },
  })
}
