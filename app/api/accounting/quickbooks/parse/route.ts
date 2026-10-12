import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts). The middleware has already checked the grant.
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { parseQbJournal } from '@/lib/accounting/quickbooks/parse-journal'
import { proposeQbAccounts } from '@/lib/accounting/quickbooks/import-journal'

/**
 * Step 1 of the migration: read a QuickBooks Journal export and propose a mapping.
 *
 * WRITES NOTHING. The user reviews the parse errors and the proposals before any import runs,
 * which is the point — a confident wrong mapping misstates a whole account for years.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  if (typeof body?.text !== 'string' || !body.text.trim()) {
    return NextResponse.json({ error: 'Paste or upload the Journal export first.' }, { status: 400 })
  }

  const group = await resolveGroupOr400(admin, gate, body?.group ?? null)
  if (group instanceof NextResponse) return group

  try {
    return NextResponse.json(await proposeQbAccounts(admin, gate.fundId, group, parseQbJournal(body.text)))
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
