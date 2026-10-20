// The accrued profit share of a GPU SPV: a DISPLAY memo, never booked (lib/gpu/accrued.ts) — the
// manager's take if the vehicle's book NAV were distributed today through its distributable-cash
// waterfall, replayed on every distribution so far.
//
//   GET ?group=X[&asOf=YYYY-MM-DD]   { asOf, bookNav, tiers, carryMemo, investorMemo, paidToDate }
//
// gp_economics (lib/access/route-domains.ts): the answer is the manager's economics, so the gate
// refuses it to a member without that grant. Its book NAV is the books restated, so the handler also
// needs accounting read (the registry maps one domain; this payload straddles two). A vehicle that
// is not a GPU SPV is a 404.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { assertVehicleKind } from '@/lib/accounting/vehicle-domain'
import { loadCarryTerms } from '@/lib/accounting/carry'
import { loadCapitalPostings } from '@/lib/accounting/capital-source'
import { loadPostedLedger } from '@/lib/accounting/load'
import { lastReserve, loadContingencyByDate, loadWaterfallHistory } from '@/lib/accounting/distributions'
import { cashWaterfallEvents, cashWaterfallTerms } from '@/lib/accounting/distribution-waterfall'
import { accruedProfitShare } from '@/lib/gpu/accrued'
import { gpuBookNav } from '@/lib/gpu/book-nav'
import { hasAccess, loadAccessContext } from '@/lib/access/effective'

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group
  const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
  if (!hasAccess(access, 'accounting', 'read')) return NextResponse.json({ error: 'You do not have access to the books.' }, { status: 403 })
  const refused = await assertVehicleKind(admin, gate.fundId, group, 'gpu_spv')
  if (refused) return refused

  const asOfParam = req.nextUrl.searchParams.get('asOf')
  if (asOfParam != null && !/^\d{4}-\d{2}-\d{2}$/.test(asOfParam)) return NextResponse.json({ error: 'asOf must be YYYY-MM-DD' }, { status: 400 })
  const asOf = asOfParam ?? new Date().toISOString().slice(0, 10)

  const terms = await loadCarryTerms(admin, gate.fundId, group)
  if (terms.kind !== 'distributable_cash') {
    return NextResponse.json({ error: 'The accrued profit share is for a distributable-cash waterfall; this vehicle has other terms.' }, { status: 400 })
  }
  const [{ postings: capital }, ledger, contingencyByDate, reserve] = await Promise.all([
    loadCapitalPostings(admin, gate.fundId, group, asOf),
    loadPostedLedger(admin, gate.fundId, group, asOf),
    loadContingencyByDate(admin, gate.fundId, group),
    lastReserve(admin, gate.fundId, group),
  ])
  const cash = cashWaterfallTerms(terms)
  try {
    const h = loadWaterfallHistory(capital, new Set(terms.recipients.map(r => r.lpEntityId)), asOf, contingencyByDate)
    const nav = gpuBookNav(ledger.accounts, ledger.postings, reserve ?? 0)
    // A periodic day count is for scenarios; a dated memo accrues 30E/360.
    return NextResponse.json(accruedProfitShare({
      events: cashWaterfallEvents(h.contributions, h.priors, asOf),
      terms: cash.dayCount === 'periodic' ? { ...cash, dayCount: '30_360' } : cash,
      bookNav: nav.bookNav,
      asOf,
    }))
  } catch (e) {
    return NextResponse.json({ error: `The waterfall could not be replayed: ${e instanceof Error ? e.message : String(e)}` }, { status: 400 })
  }
}
