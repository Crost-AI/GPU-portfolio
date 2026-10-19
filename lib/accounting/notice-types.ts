// What a notice PDF is rendered from. Apart from notice-pdf.ts so code that only assembles or
// previews a notice's figures can name these types without reaching headless Chromium
// (lib/pdf-routes.mjs lists the routes that may).

import { roundCents } from './ledger'

export type NoticeKind = 'capital_call' | 'distribution'

export interface NoticeData {
  kind: NoticeKind
  /** Fund's display face (FundTheme.displayFont). Absent = the default. */
  displayFont?: string | null
  fundName: string
  fundLogo: string | null
  fundAddress: string | null
  currency: string
  vehicle: string
  partnerName: string
  /** Date of the call or declaration — NOT today. A reissued PDF must not move it. */
  noticeDate: string
  /** Sequence within the vehicle, when the register carries one. */
  number?: number | null
  description?: string | null
  /** THE figure. Straight from the register line, frozen at issue. */
  amount: number
  /** Calls only: when the money is due. */
  dueDate?: string | null
  /** Calls only: where to send it. */
  wireInstructions?: string | null
  /**
   * Context lines shown under the amount — commitment, called to date, remaining, or capital
   * balance. Supplied by the caller as label/value pairs so the register stays the only
   * source of the amount itself.
   */
  context?: { label: string; value: number | null }[]
  /**
   * Calls only: what the WHOLE call is for, fund-wide, as frozen at issue. Shown with the
   * partner's share rather than split per partner, so no rounding makes the parts disagree with
   * the amount above.
   */
  purposes?: { label: string; amount: number; basis?: string | null }[] | null
  /** The partner's share of the vehicle's commitments, 0..1, shown beside the purposes. */
  share?: number | null
  /** A preview: marked DRAFT on every page, so it can never pass for a demand. */
  draft?: boolean
}

/** The frozen waterfall figures a distribution notice restates (the register's wf_* columns). */
export interface NoticeTiers {
  returnOfCapital: number
  preferred: number
  lpTotal: number
  /** Present when the distribution went through a distributable-cash waterfall (a GPU SPV). */
  cash?: { contingencyReturn: number; profitToLP: number; unreturnedAfter: number; prefCarriedForward: number }
}

/**
 * The "of which" rows for one LP line of a distribution notice: the line's pro-rata share of each
 * frozen tier. A fund's notice shows return of capital and the preferred return, as it always
 * has. A GPU SPV's adds the profit share and the two balances an investor asks about next, the
 * unreturned capital and the unpaid pref carried forward; pro-rata by the line is exact for a
 * single-close SPV, where every investor holds the same share of each tier.
 */
export function distributionTierLines(tiers: NoticeTiers, lineAmount: number): { label: string; value: number }[] {
  if (!(tiers.lpTotal > 0)) return []
  const share = lineAmount / tiers.lpTotal
  const of = (v: number) => roundCents(v * share)
  if (!tiers.cash) {
    const rows = [{ label: 'Of which return of capital', value: of(tiers.returnOfCapital) }]
    if (tiers.preferred > 0) rows.push({ label: 'Of which preferred return', value: of(tiers.preferred) })
    return rows
  }
  const c = tiers.cash
  const rows: { label: string; value: number }[] = []
  if (c.contingencyReturn > 0) rows.push({ label: 'Return of unspent contingency', value: of(c.contingencyReturn) })
  rows.push(
    { label: 'Preferred return', value: of(tiers.preferred) },
    { label: 'Return of capital', value: of(tiers.returnOfCapital) },
    { label: 'Profit share', value: of(c.profitToLP) },
    { label: 'Unreturned capital after this distribution', value: of(c.unreturnedAfter) },
    { label: 'Unpaid preferred return carried forward', value: of(c.prefCarriedForward) },
  )
  return rows
}
