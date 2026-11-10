// The accrued profit share of a GPU SPV: a DISPLAY memo, never booked (lib/gpu/accrued.ts) — the
// manager's take if the vehicle's book NAV were distributed today through its distributable-cash
// waterfall, replayed on every distribution so far.
//
//   GET ?group=X[&asOf=YYYY-MM-DD]   { asOf, bookNav, tiers, carryMemo, investorMemo, paidToDate }
//
// gp_economics behind the gpu_fleet switch (lib/access/route-domains.ts): the answer is the
// manager's economics, so the gate refuses it to a member without that grant, and to everyone while
// gpu_fleet is off. The route's feature key replaces gp_economics' own switch at the gate (#113), so
// the handler checks that too. Its book NAV is the books restated, so the handler also needs
// accounting read (the registry maps one domain; this payload straddles two). A vehicle that is not
// a GPU SPV is a 404.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupWithAccess } from '@/lib/accounting/http-vehicle'
import { assertVehicleKind } from '@/lib/accounting/vehicle-domain'
import { loadCarryTerms } from '@/lib/accounting/carry'
import { loadCapitalPostings } from '@/lib/accounting/capital-source'
import { loadPostedLedger } from '@/lib/accounting/load'
import { loadContingencyByDate, loadDeclaredReserves, loadWaterfallHistory, reserveOn } from '@/lib/accounting/distributions'
import { cashWaterfallEvents, cashWaterfallTerms } from '@/lib/accounting/distribution-waterfall'
import { accruedProfitShare, canSeeAccruedMemo } from '@/lib/gpu/accrued'
import { gpuBookNav } from '@/lib/gpu/book-nav'

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const resolved = await resolveGroupWithAccess(admin, gate, req.nextUrl.searchParams.get('group'))
  if (resolved instanceof NextResponse) return resolved
  const { group, access } = resolved
  // The gate checked gp_economics behind gpu_fleet; the rest of the memo's gate, shared with every surface.
  if (!canSeeAccruedMemo(access)) return NextResponse.json({ error: 'The accrued profit share needs GP economics and the books.' }, { status: 403 })
  const refused = await assertVehicleKind(admin, gate.fundId, group, 'gpu_spv')
  if (refused) return refused

  const asOfParam = req.nextUrl.searchParams.get('asOf')
  if (asOfParam != null && !/^\d{4}-\d{2}-\d{2}$/.test(asOfParam)) return NextResponse.json({ error: 'asOf must be YYYY-MM-DD' }, { status: 400 })
  const asOf = asOfParam ?? new Date().toISOString().slice(0, 10)

  const terms = await loadCarryTerms(admin, gate.fundId, group)
  if (terms.kind !== 'distributable_cash') {
    return NextResponse.json({ error: 'The accrued profit share is for a distributable-cash waterfall; this vehicle has other terms.' }, { status: 400 })
  }
  const [{ postings: capital }, ledger, contingencyByDate, reserves] = await Promise.all([
    loadCapitalPostings(admin, gate.fundId, group, asOf),
    loadPostedLedger(admin, gate.fundId, group, asOf),
    loadContingencyByDate(admin, gate.fundId, group),
    loadDeclaredReserves(admin, gate.fundId, group),
  ])
  const cash = cashWaterfallTerms(terms)
  try {
    const h = loadWaterfallHistory(capital, new Set(terms.recipients.map(r => r.lpEntityId)), asOf, contingencyByDate)
    // The reserve as at the memo's date, as the cash and the capital above are: a later declaration
    // does not reach back.
    const nav = gpuBookNav(ledger.accounts, ledger.postings, reserveOn(reserves, asOf))
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
