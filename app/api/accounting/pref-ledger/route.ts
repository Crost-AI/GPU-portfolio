// The carried-forward preferred-return ledger of a distributable-cash (GPU SPV) vehicle: per
// period, the unreturned capital, the pref accrued, paid and carried forward, per investor too.
// Derived from the capital postings every time, never stored (plan §3.6).
//
//   GET ?group=X   PrefLedgerRow[]; 400 when the vehicle's terms are not distributable_cash
//
// lp_capital domain (lib/access/route-domains.ts): it shows each investor's unreturned capital.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { loadCarryTerms } from '@/lib/accounting/carry'
import { loadCapitalPostings } from '@/lib/accounting/capital-source'
import { loadEntityNames } from '@/lib/accounting/load'
import { loadContingencyByDate, loadWaterfallHistory } from '@/lib/accounting/distributions'
import { cashWaterfallEvents, cashWaterfallTerms } from '@/lib/accounting/distribution-waterfall'
import { prefLedger } from '@/lib/gpu/waterfall'

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  const [terms, { postings }, names] = await Promise.all([
    loadCarryTerms(admin, gate.fundId, group),
    loadCapitalPostings(admin, gate.fundId, group),
    loadEntityNames(admin, gate.fundId, group),
  ])
  if (terms.kind !== 'distributable_cash') {
    return NextResponse.json({ error: 'The pref ledger is for a distributable-cash waterfall; this vehicle has other terms.' }, { status: 400 })
  }
  // Every event on the books, a future-dated one included: the ledger restates what was recorded.
  const all = '9999-12-31'
  const contingencyByDate = await loadContingencyByDate(admin, gate.fundId, group)
  const { contributions, priors } = loadWaterfallHistory(postings, new Set(terms.recipients.map(r => r.lpEntityId)), all, contingencyByDate)
  let rows
  try {
    rows = prefLedger(cashWaterfallEvents(contributions, priors, all), cashWaterfallTerms(terms))
  } catch (e) {
    return NextResponse.json({ error: `The pref ledger could not be replayed: ${e instanceof Error ? e.message : String(e)}` }, { status: 400 })
  }
  return NextResponse.json(rows.map(r => ({
    ...r,
    perInvestor: r.perInvestor?.map(i => ({ ...i, name: names.get(i.lpEntityId) ?? i.lpEntityId })),
  })))
}
