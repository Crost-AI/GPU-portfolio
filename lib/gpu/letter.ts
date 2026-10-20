// What a GPU SPV's quarterly investor letter is written from (pivot plan §5.4): the investors'
// position replayed from the books through the distributable-cash waterfall, IRR to date on their
// actual cash flows, and — for a writer who sees the manager's economics — the profit share paid
// and the accrued memo (lib/gpu/accrued.ts). Vehicle-level throughout: no investor's own figures.
//
// The brief (lib/lp-letters/brief.ts fleetBrief) turns this into labelled figures.

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadCarryTerms } from '@/lib/accounting/carry'
import { loadCapitalPostings } from '@/lib/accounting/capital-source'
import { bucketForSourceType } from '@/lib/accounting/capital-account'
import { loadPostedLedger } from '@/lib/accounting/load'
import { lastReserve, loadContingencyByDate, loadWaterfallHistory } from '@/lib/accounting/distributions'
import { cashWaterfallEvents, cashWaterfallTerms } from '@/lib/accounting/distribution-waterfall'
import { roundCents } from '@/lib/accounting/ledger'
import { xirr } from '@/lib/xirr'
import { accruedProfitShare, type AccruedProfitShare } from './accrued'
import { gpuBookNav } from './book-nav'
import { investorPosition, quarterlyReportData, type QuarterlyReportData } from './report'

export interface FleetLetterData {
  report: QuarterlyReportData
  /** Investors' IRR to date on their actual contributions and distributions; null with too few flows. */
  irrToDate: number | null
  /** The profit share as booked and as a memo; null for a writer without gp_economics. */
  profitShare: { paid: number; accrued: AccruedProfitShare } | null
  /**
   * The projected outcome from the primary fleet plan. TODO(gpu-P4 B1, #99): read it from the plan's
   * returns (getPlanReturns on the primary fleet plan, GET /api/accounting/forecast/fleet-scenarios)
   * once the distributable-cash forecast is on main; null until then.
   */
  projected: { investorIrr: number | null; investorMultiple: number | null } | null
}

/** Null when the vehicle has no distributable-cash terms: there is no waterfall position to report. */
export async function loadFleetLetterData(
  admin: SupabaseClient, fundId: string, vehicle: string, asOf: string, opts: { showCarry: boolean },
): Promise<FleetLetterData | null> {
  const terms = await loadCarryTerms(admin, fundId, vehicle)
  if (terms.kind !== 'distributable_cash') return null
  const [{ postings: capital }, contingencyByDate] = await Promise.all([
    loadCapitalPostings(admin, fundId, vehicle, asOf),
    loadContingencyByDate(admin, fundId, vehicle),
  ])
  const recipients = new Set(terms.recipients.map(r => r.lpEntityId))
  const h = loadWaterfallHistory(capital, recipients, asOf, contingencyByDate)
  const cash = cashWaterfallTerms(terms)
  const dated = cash.dayCount === 'periodic' ? { ...cash, dayCount: '30_360' as const } : cash
  const events = cashWaterfallEvents(h.contributions, h.priors, asOf)
  const position = investorPosition(events, dated, asOf)

  // The investors' own cash: what they paid in and what was paid to them (the recipients' excluded).
  // A capital posting is debit-positive: a contribution credits capital (out of the investor's pocket,
  // negative) and a distribution debits it (back to them, positive).
  const flows = capital
    .filter(p => p.lpEntityId && !recipients.has(p.lpEntityId) && p.entryDate && p.entryDate <= asOf)
    .flatMap(p => {
      const b = bucketForSourceType(p.sourceType)
      return b === 'contributions' || b === 'distributions' ? [{ date: new Date(`${p.entryDate}T00:00:00Z`), amount: roundCents(p.amount) }] : []
    })
  const irrToDate = flows.some(f => f.amount > 0) && flows.some(f => f.amount < 0) ? xirr(flows) : null

  let profitShare: FleetLetterData['profitShare'] = null
  if (opts.showCarry) {
    const [ledger, reserve] = await Promise.all([loadPostedLedger(admin, fundId, vehicle, asOf), lastReserve(admin, fundId, vehicle)])
    const nav = gpuBookNav(ledger.accounts, ledger.postings, reserve ?? 0)
    profitShare = { paid: position.managerProfitSharePaid, accrued: accruedProfitShare({ events, terms: dated, bookNav: nav.bookNav, asOf }) }
  }
  return {
    report: quarterlyReportData({ position, kpis: null, planVsActual: null }),
    irrToDate,
    profitShare,
    projected: null,
  }
}
