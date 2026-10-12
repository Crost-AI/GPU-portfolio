import { hasAccess, loadAccessContext } from '@/lib/access/effective'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts).
import { assertWriteAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { parseQbJournal } from '@/lib/accounting/quickbooks/parse-journal'
import { importQbJournal, QbImportError } from '@/lib/accounting/quickbooks/import-journal'

/**
 * Step 3: import the Journal export as DRAFT journal entries. Nothing posts.
 *
 * The work is importQbJournal (lib/accounting/quickbooks/import-journal.ts), shared with the
 * `import_journal` agent tool so a connector and a person land on the same path.
 *
 * POST — { text, group?, dryRun?, sourceLabel?, reviewToken? }
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  if (typeof body?.text !== 'string' || !body.text.trim()) {
    return NextResponse.json({ error: 'Nothing to import.' }, { status: 400 })
  }

  const group = await resolveGroupOr400(admin, gate, body?.group ?? null)
  if (group instanceof NextResponse) return group

  const { transactions, errors: parseErrors } = parseQbJournal(body.text)
  const access = await loadAccessContext(admin, gate.fundId, user.id, gate.role)

  try {
    const result = await importQbJournal(admin, {
      fundId: gate.fundId,
      group,
      userId: user.id,
      transactions,
      parseErrors,
      dryRun: !!body?.dryRun,
      reviewToken: body?.reviewToken ?? null,
      includeLp: hasAccess(access, 'lp_capital', 'read'),
      sourceLabel: body?.sourceLabel ?? null,
    })
    if ('reviewRequired' in result) {
      return NextResponse.json({ error: result.error, importReview: result.importReview }, { status: 409 })
    }
    return NextResponse.json(result)
  } catch (e) {
    const status = e instanceof QbImportError ? e.status : 500
    return NextResponse.json({ error: (e as Error).message }, { status })
  }
}

// GET — the import history for this vehicle, so a third pass can see what the second did.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group
  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)

  const { data } = await (admin as any).from('qb_import_runs')
    .select('*').eq('fund_id', gate.fundId).eq('vehicle_id', vehicleId).eq('source', 'quickbooks')
    .order('created_at', { ascending: false }).limit(20)
  return NextResponse.json({ runs: data ?? [] })
}
