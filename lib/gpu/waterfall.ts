// The distributable-cash waterfall for a GPU SPV.
//
// HOW IT DIFFERS FROM `lib/accounting/waterfall.ts`. The fund waterfall returns capital first,
// then pays a hurdle accrued on every contribution from its wire date, then catches the GP up.
// An operating SPV distributes its cash every period in a different order:
//   1. Preferred return: simple, on capital NOT YET RETURNED, so the base shrinks as capital
//      comes back. A shortfall is carried forward and earns nothing (non-compounding).
//   2. Return of capital: `rocLpShare` of the flow to investors until their capital is back.
//   3. Split: the rest goes `carryRate` to the manager and the remainder to investors.
// There is no catch-up.
//
// STATE IS REPLAYED, NEVER STORED. Like `replayWaterfallState`, a position is a pure function of
// the contributions and of the prior distribution TOTALS, so declaring twice on the same books
// gives the same split, and correcting an earlier distribution corrects every later one.
//
// VEHICLE FIRST, THEN INVESTORS. Each tier is computed from vehicle aggregates in integer cents
// and only then apportioned across investors (sorted by `lpEntityId`, with `apportionCents`), so
// the tiers never depend on how many investors there are. `preferred + returnOfCapital +
// managerRocShare + profitToLP + carry` is exactly the distribution, and so is the sum of the lines.
//
// No carry accrues at the close for this kind (Karl, R4): the manager's profit share is booked only
// when a distribution pays it. That is why there is no hypothetical-liquidation target here.

import type { CarryRecipient } from '@/lib/accounting/carry'
import type { WaterfallState } from '@/lib/accounting/waterfall'
import { apportionCents } from '@/lib/accounting/allocation'
import { roundCents } from '@/lib/accounting/ledger'

export type PrefDayCount = 'act_365' | '30_360' | 'periodic'

export interface CashWaterfallTerms {
  /** Simple preferred return on unreturned capital, e.g. 0.08. */
  prefRate: number
  /** `periodic` ignores dates: each accrual is `periodFraction` years (scenario engine, fixtures). */
  dayCount: PrefDayCount
  /** Investors' share of the return-of-capital flow; 1.0 = all of it. */
  rocLpShare: number
  /** Manager's share of the split after capital is returned, e.g. 0.30. */
  carryRate: number
  /** Who receives the manager's take, by pct (sums to 100). */
  recipients: CarryRecipient[]
}

export interface InvestorPosition {
  lpEntityId: string
  /** Cumulative capital contributed, cents-exact. */
  contributed: number
  /** Contributed less capital returned, cents-exact. */
  unreturned: number
  /**
   * Cumulative preferred return accrued, EXACT (unrounded) — rounding happens at payment. A
   * distribution that pays the vehicle's whole pref due settles this to `prefPaid`, so the sub-cent
   * difference between an exact accrual and the cents paid never leaks into the next period.
   */
  prefAccrued: number
  /** Cumulative preferred return paid, cents. */
  prefPaid: number
  /** ISO date the accrual is current to. */
  lastAccrual: string
}

export interface CashWaterfallState {
  /** Sorted by `lpEntityId`. */
  investors: InvestorPosition[]
  /** Everything paid to the recipients: carry plus the manager's return-of-capital share. */
  carryPaid: number
  /** The part of `carryPaid` that came from the return-of-capital tier. */
  managerRocPaid: number
  asOf: string
}

/**
 * A contribution, or a prior fund-wide distribution total (investors plus manager).
 * `periodFraction` is the years since the previous event, read only when `dayCount` is
 * `periodic`; a periodic distribution must carry it, a periodic contribution defaults to 0.
 */
export type WaterfallEvent =
  | { kind: 'contribution'; date: string; lpEntityId: string; amount: number; periodFraction?: number }
  | { kind: 'distribution'; date: string; amount: number; periodFraction?: number }

export interface CashTiers {
  prefDue: number
  preferred: number
  prefCarriedForward: number
  returnOfCapital: number
  managerRocShare: number
  unreturnedAfter: number
  profitToLP: number
  carry: number
  toLP: number
  toGP: number
}

export interface CashLine {
  lpEntityId: string
  amount: number
  preferred: number
  roc: number
  profit: number
}

export interface CashDistribution {
  tiers: CashTiers
  /** One line per investor (zero lines included), sorted by `lpEntityId`. */
  lines: CashLine[]
  /** The manager's take across the recipients; the last absorbs the rounding cent. */
  carryLines: { lpEntityId: string; amount: number }[]
  state: CashWaterfallState
}

export interface PrefLedgerRow {
  /** Between consecutive events. */
  periodStart: string
  periodEnd: string
  /** Vehicle total at the start of the period. */
  unreturnedStart: number
  /** This period, in cents: `prefDue − broughtForward`, so the row's identity holds exactly. */
  accrued: number
  /** Unpaid pref from earlier periods. */
  broughtForward: number
  paid: number
  /** broughtForward + accrued − paid. */
  carriedForward: number
  perInvestor?: { lpEntityId: string; accrued: number; paid: number; carriedForward: number; unreturnedEnd: number }[]
}

/** The engine-side terms plus the stored columns this kind constrains. */
export interface CashTermsInput extends Omit<CashWaterfallTerms, 'dayCount'> {
  dayCount: string
  catchupRate?: number
  prefCompounds?: boolean
  prefBasis?: string
}

const DAY_COUNTS: readonly string[] = ['act_365', '30_360', 'periodic']

/** The first rule a distributable-cash configuration breaks, or null when it is valid. */
export function validateCashTerms(terms: CashTermsInput): string | null {
  if (terms.catchupRate != null && terms.catchupRate !== 1) {
    return 'A distributable-cash waterfall has no catch-up tier; the catch-up rate must be 1.'
  }
  if (terms.prefCompounds === true) {
    return 'The preferred return on a distributable-cash waterfall is simple; it cannot compound.'
  }
  if (terms.prefBasis != null && terms.prefBasis !== 'unreturned') {
    return 'The preferred return on a distributable-cash waterfall accrues on unreturned capital only.'
  }
  if (!DAY_COUNTS.includes(terms.dayCount)) return 'Day count must be act_365, 30_360 or periodic.'
  if (!(terms.prefRate >= 0 && terms.prefRate < 1)) {
    return 'Preferred return must be a fraction between 0 and 1 (0.08 = 8%).'
  }
  if (!(terms.rocLpShare > 0 && terms.rocLpShare <= 1)) {
    return "Investors' share of the return of capital must be above 0 and at most 1 (1 = 100%)."
  }
  if (!(terms.carryRate > 0 && terms.carryRate < 1)) {
    return "The manager's profit share must be a fraction between 0 and 1 (0.3 = 30%)."
  }
  if (terms.recipients.length === 0) return 'Choose who receives the profit share.'
  const pct = terms.recipients.reduce((s, r) => s + r.pct, 0)
  if (Math.abs(pct - 100) > 0.001) return `Profit-share recipient percentages must total 100 (they total ${pct}).`
  return null
}

const DAY_MS = 24 * 60 * 60 * 1000

function parseDate(iso: string): { y: number; m: number; d: number; ms: number } {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) throw new Error(`Not a date: ${iso}`)
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return { y, m, d, ms }
}

/**
 * Years between two ISO dates. ACT/365 matches `preferredTarget`; 30/360 is the US bond basis,
 * which makes each anniversary exactly one year and so reproduces the pack's annual figures.
 */
export function yearFraction(from: string, to: string, dayCount: Exclude<PrefDayCount, 'periodic'>): number {
  const a = parseDate(from)
  const b = parseDate(to)
  if (dayCount === 'act_365') return (b.ms - a.ms) / (365 * DAY_MS)
  const d1 = Math.min(a.d, 30)
  const d2 = b.d === 31 && d1 === 30 ? 30 : b.d
  return (360 * (b.y - a.y) + 30 * (b.m - a.m) + (d2 - d1)) / 360
}

const cents = (n: number) => Math.round(roundCents(n) * 100)
const dollars = (c: number) => roundCents(c / 100)

export function emptyState(asOf: string): CashWaterfallState {
  return { investors: [], carryPaid: 0, managerRocPaid: 0, asOf }
}

/** Accrue the preferred return to `to` on each investor's unreturned capital. */
export function accrue(
  state: CashWaterfallState,
  to: string,
  terms: CashWaterfallTerms,
  periodFraction?: number,
): CashWaterfallState {
  if (terms.dayCount === 'periodic' && periodFraction == null) {
    throw new Error('A periodic accrual needs a periodFraction.')
  }
  const investors = state.investors.map(inv => {
    const years = terms.dayCount === 'periodic'
      ? periodFraction as number
      : yearFraction(inv.lastAccrual, to, terms.dayCount)
    if (years < 0) throw new Error(`Cannot accrue backwards from ${inv.lastAccrual} to ${to}.`)
    return { ...inv, prefAccrued: inv.prefAccrued + terms.prefRate * inv.unreturned * years, lastAccrual: to }
  })
  return { ...state, investors, asOf: to }
}

/** Add a contribution. An existing investor must already be accrued to its date. */
export function contribute(
  state: CashWaterfallState,
  e: Extract<WaterfallEvent, { kind: 'contribution' }>,
): CashWaterfallState {
  const existing = state.investors.find(i => i.lpEntityId === e.lpEntityId)
  if (existing && existing.lastAccrual < e.date) {
    throw new Error(`Accrue ${e.lpEntityId} to ${e.date} before adding a contribution on that date.`)
  }
  const investors = existing
    ? state.investors.map(i => i === existing
      ? { ...i, contributed: roundCents(i.contributed + e.amount), unreturned: roundCents(i.unreturned + e.amount) }
      : i)
    : [...state.investors, {
      lpEntityId: e.lpEntityId,
      contributed: roundCents(e.amount),
      unreturned: roundCents(e.amount),
      prefAccrued: 0,
      prefPaid: 0,
      lastAccrual: e.date,
    }].sort((a, b) => a.lpEntityId.localeCompare(b.lpEntityId))
  return { ...state, investors }
}

/** Split the manager's take across the recipients by pct; the last absorbs the rounding cent. */
function splitAcrossRecipients(totalCents: number, recipients: CarryRecipient[]): { lpEntityId: string; amount: number }[] {
  if (totalCents <= 0) return []
  if (recipients.length === 0) throw new Error('The waterfall pays the manager but no profit-share recipient is named.')
  const out: { lpEntityId: string; amount: number }[] = []
  let allocated = 0
  recipients.forEach((r, i) => {
    const amt = i === recipients.length - 1 ? totalCents - allocated : Math.round((totalCents * r.pct) / 100)
    allocated += amt
    if (amt > 0) out.push({ lpEntityId: r.lpEntityId, amount: dollars(amt) })
  })
  return out
}

/** Run one distribution of `amount` on `date` through the tiers (plan §3.4). */
export function distribute(
  state: CashWaterfallState,
  amount: number,
  date: string,
  terms: CashWaterfallTerms,
  periodFraction?: number,
): CashDistribution {
  const D = cents(amount)
  if (D < 0) throw new Error('A distribution cannot be negative.')
  const s = accrue(state, date, terms, periodFraction)
  const inv = s.investors
  if (D > 0 && inv.length === 0) throw new Error('No investor has contributed, so there is no one to distribute to.')

  // 1. Preferred return: the vehicle's exact owed balance, rounded once, apportioned by what each owes.
  const owed = inv.map(i => i.prefAccrued - i.prefPaid)
  const prefDue = Math.max(0, cents(owed.reduce((a, b) => a + b, 0)))
  const preferred = Math.min(D, prefDue)
  const prefLines = apportionCents(preferred, owed.map(o => Math.max(0, o)))
  const prefCarriedForward = prefDue - preferred

  // 2. Return of capital. The flow that retires all capital is unreturned / rocLpShare, in whole
  //    cents; the investors' part never exceeds what is unreturned.
  const R = D - preferred
  const unreturned = inv.map(i => cents(i.unreturned))
  const unreturnedTotal = unreturned.reduce((a, b) => a + b, 0)
  const flow = Math.min(R, Math.ceil(unreturnedTotal / terms.rocLpShare - 1e-9))
  const roc = Math.min(unreturnedTotal, cents(dollars(flow) * terms.rocLpShare))
  const managerRocShare = flow - roc
  const rocLines = apportionCents(roc, unreturned)

  // 3. Split: profit to investors by contributed capital, carry to the recipients.
  const S = R - flow
  const carry = cents(dollars(S) * terms.carryRate)
  const profitToLP = S - carry
  const profitLines = apportionCents(profitToLP, inv.map(i => cents(i.contributed)))

  const lines: CashLine[] = inv.map((i, k) => ({
    lpEntityId: i.lpEntityId,
    amount: dollars(prefLines[k] + rocLines[k] + profitLines[k]),
    preferred: dollars(prefLines[k]),
    roc: dollars(rocLines[k]),
    profit: dollars(profitLines[k]),
  }))
  const carryLines = splitAcrossRecipients(carry + managerRocShare, terms.recipients)

  const investors = inv.map((i, k) => {
    const prefPaid = roundCents(i.prefPaid + dollars(prefLines[k]))
    return {
      ...i,
      prefPaid,
      prefAccrued: prefCarriedForward === 0 ? prefPaid : i.prefAccrued,
      unreturned: dollars(unreturned[k] - rocLines[k]),
    }
  })

  return {
    tiers: {
      prefDue: dollars(prefDue),
      preferred: dollars(preferred),
      prefCarriedForward: dollars(prefCarriedForward),
      returnOfCapital: dollars(roc),
      managerRocShare: dollars(managerRocShare),
      unreturnedAfter: dollars(unreturnedTotal - roc),
      profitToLP: dollars(profitToLP),
      carry: dollars(carry),
      toLP: dollars(preferred + roc + profitToLP),
      toGP: dollars(carry + managerRocShare),
    },
    lines,
    carryLines,
    state: {
      investors,
      carryPaid: roundCents(s.carryPaid + dollars(carry + managerRocShare)),
      managerRocPaid: roundCents(s.managerRocPaid + dollars(managerRocShare)),
      asOf: date,
    },
  }
}

/** Date order; on the same date contributions come first, as `replayWaterfallState` counts them. */
function ordered(events: WaterfallEvent[]): WaterfallEvent[] {
  return [...events].sort((a, b) =>
    a.date.localeCompare(b.date) || (a.kind === b.kind ? 0 : a.kind === 'contribution' ? -1 : 1))
}

function fractionOf(e: WaterfallEvent, terms: CashWaterfallTerms): number | undefined {
  if (terms.dayCount !== 'periodic') return undefined
  if (e.kind === 'distribution' && e.periodFraction == null) {
    throw new Error(`The periodic distribution on ${e.date} needs a periodFraction.`)
  }
  return e.periodFraction ?? 0
}

function apply(state: CashWaterfallState, e: WaterfallEvent, terms: CashWaterfallTerms): { state: CashWaterfallState; dist?: CashDistribution } {
  const fraction = fractionOf(e, terms)
  if (e.kind === 'distribution') {
    const dist = distribute(state, e.amount, e.date, terms, fraction)
    return { state: dist.state, dist }
  }
  return { state: contribute(accrue(state, e.date, terms, fraction), e) }
}

/**
 * The position as at `asOf`: every event on or before it, in order, then accrued to `asOf`.
 * Under `periodic` the pref accrues only at events, so `asOf` adds nothing.
 */
export function replay(events: WaterfallEvent[], terms: CashWaterfallTerms, asOf: string): CashWaterfallState {
  const live = ordered(events).filter(e => e.date <= asOf)
  let state = emptyState(live[0]?.date ?? asOf)
  for (const e of live) state = apply(state, e, terms).state
  return accrue(state, asOf, terms, terms.dayCount === 'periodic' ? 0 : undefined)
}

/** The carried-forward pref ledger: one row per event, derived, never stored (plan §3.6). */
export function prefLedger(events: WaterfallEvent[], terms: CashWaterfallTerms): PrefLedgerRow[] {
  const rows: PrefLedgerRow[] = []
  const sorted = ordered(events)
  let state = emptyState(sorted[0]?.date ?? '')
  let broughtForward = 0
  for (const e of sorted) {
    const before = state
    const { state: after, dist } = apply(state, e, terms)
    state = after
    // Owed after a contribution is rounded once, the same way a distribution rounds its pref due.
    const due = dist ? dist.tiers.prefDue : roundCents(state.investors.reduce((s, i) => s + i.prefAccrued - i.prefPaid, 0))
    const paid = dist ? dist.tiers.preferred : 0
    const carriedForward = dist ? dist.tiers.prefCarriedForward : due
    rows.push({
      periodStart: before.asOf,
      periodEnd: e.date,
      unreturnedStart: roundCents(before.investors.reduce((s, i) => s + i.unreturned, 0)),
      accrued: roundCents(due - broughtForward),
      broughtForward,
      paid,
      carriedForward,
      perInvestor: state.investors.map(i => {
        const was = before.investors.find(b => b.lpEntityId === i.lpEntityId)
        const owedBefore = was ? was.prefAccrued - was.prefPaid : 0
        const linePaid = dist?.lines.find(l => l.lpEntityId === i.lpEntityId)?.preferred ?? 0
        const owedAfter = i.prefAccrued - i.prefPaid
        return {
          lpEntityId: i.lpEntityId,
          accrued: roundCents(owedAfter + linePaid - owedBefore),
          paid: linePaid,
          carriedForward: roundCents(owedAfter),
          unreturnedEnd: i.unreturned,
        }
      }),
    })
    broughtForward = carriedForward
  }
  return rows
}

/** Project onto the fund waterfall's state, for `DistributionSplit.stateBefore/After`. */
export function toWaterfallState(s: CashWaterfallState): WaterfallState {
  const sum = (f: (i: InvestorPosition) => number) => roundCents(s.investors.reduce((t, i) => t + f(i), 0))
  return {
    contributedCapital: sum(i => i.contributed),
    returnedCapital: sum(i => i.contributed - i.unreturned),
    preferredPaid: sum(i => i.prefPaid),
    preferredTarget: sum(i => i.prefAccrued),
    gpCarryPaid: s.carryPaid,
  }
}
