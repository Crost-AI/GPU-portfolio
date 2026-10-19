// The accrued profit share: a DISPLAY memo, never booked (Karl, update 2026-10-19).
//
// The books stay on a cash basis: the manager's profit share is booked only when a distribution
// pays it (R4 — no carry accrues at the close for a distributable_cash vehicle). Investors still
// want to see what it would be: the manager's take if the vehicle's current book NAV were
// distributed today through the distributable-cash waterfall, replayed on every distribution so far.
// That figure is this memo. It is never posted, never in the K-1 data, and gp_economics-gated
// wherever it is shown.
//
// Pure: the caller supplies the waterfall events, the vehicle's terms and its book NAV.

import { roundCents } from '@/lib/accounting/ledger'
import { distribute, replay, type CashTiers, type CashWaterfallTerms, type WaterfallEvent } from './waterfall'

export interface AccruedProfitShare {
  asOf: string
  bookNav: number
  /** The hypothetical distribution of `bookNav` on `asOf`, after the replay. */
  tiers: CashTiers
  /** The manager's take of it: profit share plus any return-of-capital share. */
  carryMemo: number
  /** The investors' part of it. */
  investorMemo: number
  /** The manager's take actually PAID by the distributions so far (Karl Q8: paid, booked). */
  paidToDate: number
}

const NO_TIERS: CashTiers = {
  contingencyReturn: 0, prefDue: 0, preferred: 0, prefCarriedForward: 0, returnOfCapital: 0, managerRocShare: 0,
  unreturnedAfter: 0, profitToLP: 0, carry: 0, toLP: 0, toGP: 0,
}

export function accruedProfitShare(input: { events: WaterfallEvent[]; terms: CashWaterfallTerms; bookNav: number; asOf: string }): AccruedProfitShare {
  const { terms, asOf } = input
  // A periodic day count accrues only at its events, so the hypothetical adds no period of its own.
  const fraction = terms.dayCount === 'periodic' ? 0 : undefined
  const state = replay(input.events, terms, asOf)
  const bookNav = Math.max(0, roundCents(input.bookNav))
  const unreturned = roundCents(state.investors.reduce((s, i) => s + i.unreturned, 0))
  if (bookNav === 0 || state.investors.length === 0) {
    return { asOf, bookNav, tiers: { ...NO_TIERS, unreturnedAfter: unreturned }, carryMemo: 0, investorMemo: 0, paidToDate: state.carryPaid }
  }
  const { tiers } = distribute(state, bookNav, asOf, terms, fraction)
  return {
    asOf, bookNav, tiers,
    carryMemo: roundCents(tiers.carry + tiers.managerRocShare),
    investorMemo: tiers.toLP,
    paidToDate: state.carryPaid,
  }
}
