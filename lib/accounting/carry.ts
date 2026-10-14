// Accrued carried interest.
//
// THE IDEA. At each close, ask: "if the fund liquidated at today's NAV, what would the GP be
// entitled to?" That number is the TARGET accrual. Split it across the LPs, compare each LP's
// share to the carry that LP has already borne, and post the difference. Because the target is
// recomputed from scratch every period, the accrual reverses on its own when NAV falls — no
// special case, no clawback logic.
//
// This is the hypothetical-liquidation method, and it is what ASC 946 expects. Without it every
// LP's NAV overstates what they would actually receive by the GP's share of the unrealized
// gain.
//
// IT IS AN EQUITY REALLOCATION, NOT AN EXPENSE. Dr each LP's capital, Cr the GP's capital.
// It never touches P&L and never touches cash — which is precisely why the close has to do it
// AFTER every other category has landed: carry is computed on the NAV that those allocations
// produce.

import type { SupabaseClient } from '@supabase/supabase-js'
import { runWaterfall, type WaterfallTerms } from './waterfall'
import { roundCents } from './ledger'
import { allocateAmount } from './allocation'
import type { CapitalAccount } from './capital-account'
import { vehicleIdByName } from './vehicle-id'

export type CarryKind = 'none' | 'straight' | 'american' | 'european'

export interface CarryRecipient {
  lpEntityId: string
  /** Share of the accrued carry, 0–100. The set sums to 100. */
  pct: number
}

export interface VehicleCarryTerms {
  kind: CarryKind
  carryRate: number
  prefRate: number
  catchupRate: number
  prefCompounds: boolean
  /** Single-recipient legacy field; kept for back-compat and as the fallback source. */
  gpEntityId: string | null
  /** Who receives the carry and in what split. Resolved from `carry_recipients`, or
   *  `[{ gpEntityId, 100 }]` when only the legacy field is set, else []. */
  recipients: CarryRecipient[]
}

export const NO_CARRY: VehicleCarryTerms = {
  kind: 'none',
  carryRate: 0,
  prefRate: 0,
  catchupRate: 1,
  prefCompounds: true,
  gpEntityId: null,
  recipients: [],
}

/** Resolve the carry recipients: the explicit list if present, else the legacy single GP at 100%. */
export function resolveCarryRecipients(carryRecipients: unknown, gpEntityId: string | null): CarryRecipient[] {
  if (Array.isArray(carryRecipients)) {
    const list = carryRecipients
      .filter((r): r is { lpEntityId: string; pct: unknown } => !!r && typeof r.lpEntityId === 'string')
      .map(r => ({ lpEntityId: r.lpEntityId, pct: Number(r.pct) }))
      .filter(r => Number.isFinite(r.pct) && r.pct > 0)
    if (list.length > 0) return list
  }
  return gpEntityId ? [{ lpEntityId: gpEntityId, pct: 100 }] : []
}

/** One LP's economics, as at the accrual date. All from the ledger. */
export interface LpEconomics {
  lpEntityId: string
  /** Cumulative capital contributed (positive). */
  contributed: number
  /** Cumulative distributions received (positive). */
  distributed: number
  /** Current capital account balance, BEFORE this period's carry accrual — so NET of the carry
   *  earlier closes already debited (`carryBorne`). */
  nav: number
  /**
   * Cumulative carry already debited from THIS LP's capital (positive; the negated
   * `carriedInterest` bucket). `nav + carryBorne` is the LP's gross, pre-carry NAV, which is what
   * carry is measured on: measuring it on `nav` would take carry on a NAV already net of carry,
   * and every re-close with no economic change would reverse part of it.
   */
  carryBorne: number
}

/**
 * The paying LPs' economics from their capital accounts. Current recipients are left out — they
 * receive carry, they don't pay it. The roll-forward stores distributions and borne carry negative.
 *
 * Only a DEBIT balance on the carry line is carry borne. A FORMER recipient (the recipient set
 * changed) holds a credit there — carry it earned — which is neither borne nor part of its own
 * pre-carry value: it is stripped from `nav`, so the partner is measured on its own gross position
 * and its historical carry is left where it was booked rather than clawed back to the new
 * recipient. An entity that has both borne and received carry is netted in that one bucket and
 * cannot be split here.
 */
export function lpEconomicsFromAccounts(
  accounts: Map<string, CapitalAccount>,
  recipientIds: Set<string>
): LpEconomics[] {
  return Array.from(accounts.entries())
    .filter(([id]) => !recipientIds.has(id))
    .map(([lpEntityId, a]) => ({
      lpEntityId,
      contributed: roundCents(a.contributions),
      distributed: roundCents(-a.distributions),
      nav: roundCents(a.ending - Math.max(0, a.carriedInterest)),
      carryBorne: roundCents(Math.max(0, -a.carriedInterest)),
    }))
}

/** A dated contribution, for accruing the preferred return. */
export interface DatedContribution {
  date: string
  amount: number
}

/**
 * The preferred return owed to LPs as at `asOf`.
 *
 * The hurdle accrues on each contribution from the day it was made — money committed on paper
 * earns nothing; money actually WIRED does. The ledger has these dates, so we use them rather
 * than approximating from a fund vintage.
 */
export function preferredTarget(
  contributions: DatedContribution[],
  asOf: string,
  rate: number,
  compounds: boolean
): number {
  if (rate <= 0) return 0

  const end = Date.parse(asOf)
  if (Number.isNaN(end)) return 0

  let total = 0
  for (const c of contributions) {
    const start = Date.parse(c.date)
    if (Number.isNaN(start) || start >= end || c.amount <= 0) continue
    // ACTUAL/365, the usual convention in an LPA. Using 365.25 would make "one year" 0.9993 of
    // a year and quietly understate the hurdle — small, but it compounds, and it is the kind of
    // difference an LP's accountant will find.
    const years = (end - start) / (365 * 24 * 60 * 60 * 1000)
    total += compounds
      ? c.amount * (Math.pow(1 + rate, years) - 1)
      : c.amount * rate * years
  }
  return roundCents(total)
}

export interface CarryTargetInput {
  lps: LpEconomics[]
  /** Dated LP contributions, for the preferred-return accrual. European/American. */
  contributions?: DatedContribution[]
  /** The date the accrual is measured at. European/American. */
  asOf?: string
}

/**
 * The GP's TOTAL carry entitlement if the fund liquidated at today's NAV.
 *
 * Not the amount to post — that is each LP's share of this less what the LP has already borne.
 * See `carryAccrual`.
 */
export function carryTarget(input: CarryTargetInput, terms: VehicleCarryTerms): number {
  if (terms.kind === 'none' || terms.carryRate <= 0) return 0

  const contributed = roundCents(input.lps.reduce((s, l) => s + l.contributed, 0))
  const distributed = roundCents(input.lps.reduce((s, l) => s + l.distributed, 0))
  // Gross of the carry already accrued: the GP's entitlement comes out of the pre-carry value.
  const nav = roundCents(input.lps.reduce((s, l) => s + l.nav + l.carryBorne, 0))

  // What the LPs would hold in total if we sold everything today.
  const liquidation = roundCents(nav + distributed)

  if (terms.kind === 'straight') {
    // Profit over contributed capital, GP takes its rate. No pref, no catch-up.
    const profit = roundCents(liquidation - contributed)
    if (profit <= 0) return 0
    return roundCents(profit * terms.carryRate)
  }

  // European (whole-fund) AND American (deal-by-deal) accrue the SAME target here.
  //
  // American doesn't earn the GP MORE carry than European — it earns the same total, just PAID
  // earlier (as individual deals realize), with a clawback that pulls back any carry later deals
  // prove was overpaid. Since this close accrues carry as-if-liquidated-at-today's-NAV — i.e. the
  // GP's ULTIMATE entitlement — and the clawback makes that ultimate total identical to European,
  // the prudent accrued MARK is the whole-fund result for both. (Accruing a deal-by-deal "winners
  // only" figure would overstate the GP and understate LP NAV.) The genuine American difference —
  // distributing realized carry cash per deal before the whole fund is made whole — is a
  // distribution-timing concern, not an accrual one, and lives outside this mark. Run the real
  // waterfall on the hypothetical liquidation proceeds.
  const pref = preferredTarget(
    input.contributions ?? [],
    input.asOf ?? new Date(0).toISOString().slice(0, 10),
    terms.prefRate,
    terms.prefCompounds
  )

  const wfTerms: WaterfallTerms = { carryRate: terms.carryRate, catchUpRate: terms.catchupRate }
  const result = runWaterfall(liquidation, wfTerms, {
    contributedCapital: contributed,
    returnedCapital: 0,
    preferredPaid: 0,
    preferredTarget: pref,
    gpCarryPaid: 0,
  })

  // Everything the GP takes across the catch-up and carry tiers.
  return roundCents(result.toCatchUp + result.toCarryGP)
}

/** A vehicle's carry terms. Absent row = no carry, which is the only safe default:
 *  accruing carry nobody agreed to is worse than accruing none. THROWS if the read fails. */
export async function loadCarryTerms(
  admin: SupabaseClient,
  fundId: string,
  group: string
): Promise<VehicleCarryTerms> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return NO_CARRY

  const { data, error } = await admin
    .from('vehicle_waterfall_terms' as any)
    .select('kind, carry_rate, pref_rate, catchup_rate, pref_compounds, gp_entity_id, carry_recipients')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .maybeSingle()
  // A failed read is not "no carry": closing on it would skip the accrual and still balance.
  if (error) throw new Error(`vehicle_waterfall_terms read failed: ${error.message}`)

  if (!data) return NO_CARRY
  const d = data as any
  const kind: CarryKind =
    d.kind === 'straight' || d.kind === 'american' || d.kind === 'european' ? d.kind : 'none'

  return {
    kind,
    carryRate: Number(d.carry_rate ?? 0),
    prefRate: Number(d.pref_rate ?? 0),
    catchupRate: Number(d.catchup_rate ?? 1),
    prefCompounds: d.pref_compounds !== false,
    gpEntityId: d.gp_entity_id ?? null,
    recipients: resolveCarryRecipients(d.carry_recipients, d.gp_entity_id ?? null),
  }
}

export interface CarryAccrual {
  /** Total entitlement at today's NAV. */
  target: number
  /** What is already sitting in the recipients' carriedInterest buckets. Reported, not posted
   *  against — the posting reconciles each LP to its own share. */
  alreadyAccrued: number
  /** What to post: target less the carry the LPs have already borne. Negative = a reversal. */
  delta: number
  /** Per-LP debit. Positive reduces that LP's capital. Sums to `delta`. */
  perLp: Map<string, number>
}

/** Each LP's gain on the gross (pre-carry) basis the target is measured on. */
function grossProfit(l: LpEconomics): number {
  return roundCents(l.nav + l.carryBorne + l.distributed - l.contributed)
}

/**
 * Each LP's share of a carry `target`: pro-rata to gross profit, nothing for an LP not in
 * profit. Largest-remainder, so the shares sum EXACTLY to the target; LPs are ordered by id
 * first, so the odd cent lands on the same LP however the ledger read happened to order them. Throws if there is a target but no LP in profit to bear it
 * (unreachable: a positive target means the fund as a whole is in profit, so some LP is).
 */
export function carryTargetShares(lps: LpEconomics[], target: number): Map<string, number> {
  if (target <= 0) return new Map()
  const inProfit = lps
    .map(l => ({ lpEntityId: l.lpEntityId, commitment: grossProfit(l) }))
    .filter(p => p.commitment > 0)
    .sort((a, b) => (a.lpEntityId < b.lpEntityId ? -1 : a.lpEntityId > b.lpEntityId ? 1 : 0))
  if (inProfit.length === 0) throw new Error(`Carry target of ${target} but no partner has a gain to bear it`)
  return allocateAmount(target, inProfit)
}

/**
 * What this period's close should post.
 *
 * RECONCILES TO A TARGET per LP, it does not post a fund-level delta. The target is shared across
 * LPs in proportion to each one's gross PROFIT — carry is a share of gains, so an LP sitting on a
 * loss bears none of it, and an LP with twice the gain bears twice as much. Each LP's posting is
 * its share less the carry it has already borne. So a re-close with nothing changed posts nothing,
 * a fall in NAV hands carry back along the path it was built, an LP that has fallen under water
 * gets all of its carry back even while another LP is still in profit, and when nobody is in
 * profit the whole accrual reverses.
 */
export function carryAccrual(
  input: CarryTargetInput,
  terms: VehicleCarryTerms,
  alreadyAccrued: number
): CarryAccrual {
  const target = carryTarget(input, terms)
  const perLp = new Map<string, number>()
  // Deterministic shares are what make an unchanged re-close post zero.
  const shares = carryTargetShares(input.lps, target)

  let delta = 0
  for (const l of input.lps) {
    const amount = roundCents((shares.get(l.lpEntityId) ?? 0) - l.carryBorne)
    if (amount === 0) continue
    perLp.set(l.lpEntityId, amount)
    delta = roundCents(delta + amount)
  }

  return { target, alreadyAccrued, delta, perLp }
}
