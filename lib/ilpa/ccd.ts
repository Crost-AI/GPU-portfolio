// One partner's data for the ILPA Capital Call & Distribution Template, built from the notice register. Pure: no
// I/O, so every mapping and total here is pinned by ccd.test.ts. The loader (ccd-load.ts) reads the
// register and the partner's standing; this file decides what ILPA calls each line and does the
// template's arithmetic.
//
// WHAT MAPS TO WHAT, and what the app does not know yet:
//
//   * A call's purposes (frozen at issue, fund-wide) become Investments / Management Fees /
//     Partnership Expenses lines at the partner's share. A call issued without purposes is one
//     "Total Amount - Inside Fund" line — ILPA's own type for a GP that cannot itemize, rather
//     than a guess at a split.
//   * A charge collected with a call (late interest, an equalization amount) is outside the
//     commitment: "Capital Call: Other", Outside Fund, no impact on unfunded, described.
//   * A distribution's character (return of capital, realized gain, income) becomes those three
//     lines; an in-kind distribution uses the Stock variants. Without a character, a waterfall's
//     return-of-capital tier splits it; without either, it is one "Distribution: Other" line.
//   * A deduction from a distribution: tax withheld is "Distribution: Tax Withheld"; anything else
//     (a fee, an unpaid call netted off) is money the partner pays the fund, "Capital Call: Other".
//   * The GP's carry line is a distribution to the GP, "Distribution: Other", described as carry.
//     An LP's line is already net of carry, so no "Distribution: Carry" line is added to it.
//   * Nothing records recallability or a return of excess capital yet, so every distribution
//     line states No Impact on unfunded and no negative contribution is produced.

import { roundCents } from '@/lib/accounting/ledger'
import type { PurposeCategory } from '@/lib/accounting/capital-call-check'
import type { DistributionCharacter } from '@/lib/accounting/distribution-character'
import {
  ccdColumn,
  ccdImpactValue,
  ccdNetSign,
  ILPA_CCD_VERSION,
  type CcdInsideOutside,
  type CcdTransactionType,
  type CcdUnfundedImpact,
} from './ccd-types'

export interface CcdTransaction {
  description: string
  type: CcdTransactionType
  /** Entered positive, as the template asks (a realized loss is the one negative). */
  lpAmount: number
  impact: CcdUnfundedImpact
  /** The signed change to unfunded commitment. */
  impactValue: number
  /** Called (+) or distributed (−). */
  netAmount: number
  insideOutside: CcdInsideOutside
}

export interface CcdFlows { contributions: number; distributions: number; net: number }

export interface CcdNotice {
  template: 'ILPA Capital Call & Distribution Template'
  version: typeof ILPA_CCD_VERSION
  kind: 'capital_call' | 'distribution'
  noticeDate: string
  dueDate: string | null
  fund: {
    name: string
    currency: string
    /** Total commitments across every partner of the vehicle. */
    size: number
    gpCommitment: number
    /** The whole notice, every partner: contributions positive, distributions negative. */
    currentNotice: CcdFlows
  }
  lp: {
    id: string
    name: string
    commitment: number
    /** LP commitment / fund size. */
    percentOfFund: number | null
    insideFund: {
      current: CcdFlows
      /** This LP's share of the fund amount on this notice, per column. */
      percentOfFundAmount: { contributions: number | null; distributions: number | null; net: number | null }
      cumulativePrior: { contributions: number; distributions: number }
      cumulativeIncluding: { contributions: number; distributions: number }
    }
    outsideFund: { outflowFromLp: number; inflowToLp: number; net: number }
    unfunded: {
      prior: number
      impact: number
      expiredReleased: number
      otherAdjustment: number
      after: number
    }
    /** Net amount called / (distributed) on this notice, inside and outside together. */
    totalNet: number
  }
  transactions: CcdTransaction[]
  footnotes: string[]
}

const CALL_TYPE: Record<PurposeCategory, CcdTransactionType> = {
  investment: 'Capital Call: Investments',
  management_fee: 'Capital Call: Management Fees',
  fund_expense: 'Capital Call: Partnership Expenses',
  other: 'Capital Call: Other (Provide explanation in far-left column)',
}

const PURPOSE_TEXT: Record<PurposeCategory, string> = {
  investment: 'Investments',
  management_fee: 'Management fees',
  fund_expense: 'Partnership expenses',
  other: 'Other',
}

export function txn(description: string, type: CcdTransactionType, amount: number, impact: CcdUnfundedImpact, insideOutside: CcdInsideOutside = 'Inside'): CcdTransaction {
  const lpAmount = roundCents(amount)
  return {
    description,
    type,
    lpAmount,
    impact,
    impactValue: roundCents(ccdImpactValue(impact, lpAmount)),
    netAmount: roundCents(ccdNetSign(type) * lpAmount),
    insideOutside,
  }
}

/**
 * Split `total` across `weights` to the cent, the rounding remainder on the largest part, so the
 * lines always add back to the frozen register amount.
 */
export function splitToCents(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0)
  if (weights.length === 0) return []
  if (sum === 0) return weights.map((_, i) => (i === 0 ? roundCents(total) : 0))
  const parts = weights.map(w => roundCents((total * w) / sum))
  const diff = roundCents(total - parts.reduce((s, p) => s + p, 0))
  if (diff !== 0) {
    let big = 0
    for (let i = 1; i < weights.length; i++) if (Math.abs(weights[i]) > Math.abs(weights[big])) big = i
    parts[big] = roundCents(parts[big] + diff)
  }
  return parts
}

export interface CallLineInput {
  /** The partner's frozen register amount. */
  amount: number
  description: string | null
  /** Fund-wide purposes frozen at issue; null or empty when the call was issued without them. */
  purposes: { category: PurposeCategory; amount: number; description?: string | null }[] | null
  /** Charges collected with this call from this partner. */
  charges: { amount: number; description: string }[]
}

export function callTransactions(input: CallLineInput): CcdTransaction[] {
  const out: CcdTransaction[] = []
  const purposes = (input.purposes ?? []).filter(p => Math.abs(p.amount) > 0.004)
  if (purposes.length === 0) {
    out.push(txn(input.description || 'Capital call', 'Capital Call: Total Amount - Inside Fund', input.amount, 'Decrease'))
  } else {
    const parts = splitToCents(input.amount, purposes.map(p => p.amount))
    purposes.forEach((p, i) => {
      if (Math.abs(parts[i]) < 0.005) return
      out.push(txn(p.description || PURPOSE_TEXT[p.category], CALL_TYPE[p.category], parts[i], 'Decrease'))
    })
  }
  for (const c of input.charges) {
    if (Math.abs(c.amount) < 0.005) continue
    out.push(txn(c.description, 'Capital Call: Other (Provide explanation in far-left column)', c.amount, 'No Impact', 'Outside'))
  }
  return out
}

export interface DistributionLineInput {
  amount: number
  role: 'lp' | 'carry'
  description: string | null
  /** 'cash' | 'in_kind' | 'other' (K-1 box 19). */
  kind: string
  /** This line's share of the declared character; all zero when never characterised. */
  character: DistributionCharacter
  /** This line's share of the waterfall's return-of-capital tier, when declared through one. */
  waterfallReturnOfCapital: number | null
  deductions: { amount: number; description: string }[]
}

export function distributionTransactions(input: DistributionLineInput): CcdTransaction[] {
  const out: CcdTransaction[] = []
  const label = input.description || 'Distribution'
  const stock = input.kind === 'in_kind'
  if (input.role === 'carry') {
    out.push(txn(`${label} — carried interest`, 'Distribution: Other (Provide explanation in far-left column)', input.amount, 'No Impact'))
  } else {
    const c = input.character
    const charTotal = c.returnOfCapital + c.realizedGain + c.income
    let buckets: { type: CcdTransactionType; weight: number; text: string }[]
    if (Math.abs(charTotal) > 0.004) {
      buckets = [
        { type: stock ? 'Distribution: Return of Capital - Stock' : 'Distribution: Return of Capital - Cash', weight: c.returnOfCapital, text: 'return of capital' },
        { type: stock ? 'Distribution: Realized Gain / (Loss) - Stock (input negative value for loss)' : 'Distribution: Realized Gain / (Loss) - Cash (input negative value for loss)', weight: c.realizedGain, text: 'realized gain' },
        { type: 'Distribution: Income', weight: c.income, text: 'income' },
      ]
    } else if (input.waterfallReturnOfCapital != null) {
      const roc = Math.min(Math.max(input.waterfallReturnOfCapital, 0), input.amount)
      buckets = [
        { type: stock ? 'Distribution: Return of Capital - Stock' : 'Distribution: Return of Capital - Cash', weight: roc, text: 'return of capital' },
        { type: stock ? 'Distribution: Realized Gain / (Loss) - Stock (input negative value for loss)' : 'Distribution: Realized Gain / (Loss) - Cash (input negative value for loss)', weight: input.amount - roc, text: 'realized gain' },
      ]
    } else {
      buckets = [{ type: 'Distribution: Other (Provide explanation in far-left column)', weight: 1, text: 'not characterised' }]
    }
    const parts = splitToCents(input.amount, buckets.map(b => b.weight))
    buckets.forEach((b, i) => {
      if (Math.abs(parts[i]) < 0.005) return
      out.push(txn(`${label} — ${b.text}`, b.type, parts[i], 'No Impact'))
    })
  }
  for (const d of input.deductions) {
    if (Math.abs(d.amount) < 0.005) continue
    const tax = /\btax/i.test(d.description)
    out.push(tax
      ? txn(d.description, 'Distribution: Tax Withheld', d.amount, 'No Impact')
      : txn(`Deducted from distribution: ${d.description}`, 'Capital Call: Other (Provide explanation in far-left column)', d.amount, 'No Impact'))
  }
  return out
}

export interface CcdNoticeInput {
  kind: 'capital_call' | 'distribution'
  noticeDate: string
  dueDate: string | null
  fundName: string
  currency: string
  fundSize: number
  gpCommitment: number
  /** Every partner's register lines on this notice, summed: called (calls) or declared (distributions). */
  noticeTotal: number
  lp: {
    id: string
    name: string
    commitment: number
    /** Called from this partner on notices before this one. */
    contributionsPrior: number
    /** Distributed to this partner on notices before this one (positive). */
    distributionsPrior: number
  }
  transactions: CcdTransaction[]
  footnotes?: string[]
}

export function buildCcdNotice(input: CcdNoticeInput): CcdNotice {
  const r = roundCents
  const inside = input.transactions.filter(t => t.insideOutside === 'Inside')
  const outside = input.transactions.filter(t => t.insideOutside === 'Outside')
  const sumNet = (ts: CcdTransaction[]) => r(ts.reduce((s, t) => s + t.netAmount, 0))
  const insideContrib = sumNet(inside.filter(t => ccdColumn(t.type) === 'contribution'))
  const insideDist = sumNet(inside.filter(t => ccdColumn(t.type) === 'distribution'))
  const outflow = r(outside.filter(t => t.netAmount > 0).reduce((s, t) => s + t.netAmount, 0))
  const inflow = r(outside.filter(t => t.netAmount < 0).reduce((s, t) => s + t.netAmount, 0))

  const fundContrib = input.kind === 'capital_call' ? r(input.noticeTotal) : 0
  const fundDist = input.kind === 'distribution' ? r(-input.noticeTotal) : 0
  const pct = (part: number, whole: number) => (Math.abs(whole) > 0.004 ? Math.abs(part / whole) : null)

  const priorContrib = r(input.lp.contributionsPrior)
  const priorDist = r(-Math.abs(input.lp.distributionsPrior))
  const unfundedPrior = r(input.lp.commitment - priorContrib)
  const impact = r(input.transactions.reduce((s, t) => s + t.impactValue, 0))

  return {
    template: 'ILPA Capital Call & Distribution Template',
    version: ILPA_CCD_VERSION,
    kind: input.kind,
    noticeDate: input.noticeDate,
    dueDate: input.dueDate,
    fund: {
      name: input.fundName,
      currency: input.currency,
      size: r(input.fundSize),
      gpCommitment: r(input.gpCommitment),
      currentNotice: { contributions: fundContrib, distributions: fundDist, net: r(fundContrib + fundDist) },
    },
    lp: {
      id: input.lp.id,
      name: input.lp.name,
      commitment: r(input.lp.commitment),
      percentOfFund: input.fundSize > 0 ? input.lp.commitment / input.fundSize : null,
      insideFund: {
        current: { contributions: insideContrib, distributions: insideDist, net: r(insideContrib + insideDist) },
        percentOfFundAmount: {
          contributions: pct(insideContrib, fundContrib),
          distributions: pct(insideDist, fundDist),
          net: pct(insideContrib + insideDist, fundContrib + fundDist),
        },
        cumulativePrior: { contributions: priorContrib, distributions: priorDist },
        cumulativeIncluding: { contributions: r(priorContrib + insideContrib), distributions: r(priorDist + insideDist) },
      },
      outsideFund: { outflowFromLp: outflow, inflowToLp: inflow, net: r(outflow + inflow) },
      unfunded: { prior: unfundedPrior, impact, expiredReleased: 0, otherAdjustment: 0, after: r(unfundedPrior + impact) },
      totalNet: sumNet(input.transactions),
    },
    transactions: input.transactions,
    footnotes: input.footnotes ?? [],
  }
}

/**
 * The notice as worksheet rows. The layout is this app's own: a section per block, one field per
 * row, then the transactions. Field names follow ILPA's so each value can be mapped onto the
 * template (or loaded by an LP's system) without interpretation.
 */
export function ccdSheetRows(n: CcdNotice): (string | number | null)[][] {
  const lp = n.lp
  const pct = (v: number | null) => (v == null ? null : v)
  const title = n.kind === 'capital_call' ? 'Capital call' : 'Distribution'
  const rows: (string | number | null)[][] = [
    [`${title} — ${n.fund.name}`],
    [`Data for the ILPA Capital Call & Distribution Template (v. ${n.version})`],
    [],
    ['Notice'],
    ['Notice Date', n.noticeDate],
    ['Due Date', n.dueDate],
    ['Fund Name', n.fund.name],
    ['Fund Currency', n.fund.currency],
    ['Fund Size', n.fund.size],
    ['GP Commitment Amount', n.fund.gpCommitment],
    ['Fund Amount (Current Notice) — Contributions', n.fund.currentNotice.contributions],
    ['Fund Amount (Current Notice) — Distributions', n.fund.currentNotice.distributions],
    ['Fund Amount (Current Notice) — Net Cash Flow', n.fund.currentNotice.net],
    [],
    ['Partner'],
    ['LP / ID Number', lp.name],
    ['LP Commitment', lp.commitment],
    ['LP % of Fund (LP Commitment / Fund Size)', pct(lp.percentOfFund)],
    ['Inside Fund — LP Amount (Current Notice) — Contributions', lp.insideFund.current.contributions],
    ['Inside Fund — LP Amount (Current Notice) — Distributions', lp.insideFund.current.distributions],
    ['Inside Fund — LP Amount (Current Notice) — Net Cash Flow', lp.insideFund.current.net],
    ['Inside Fund — As a % of Fund Amount — Contributions', pct(lp.insideFund.percentOfFundAmount.contributions)],
    ['Inside Fund — As a % of Fund Amount — Distributions', pct(lp.insideFund.percentOfFundAmount.distributions)],
    ['Inside Fund — Cumulative LP Amount (Prior to Current Notice) — Contributions', lp.insideFund.cumulativePrior.contributions],
    ['Inside Fund — Cumulative LP Amount (Prior to Current Notice) — Distributions', lp.insideFund.cumulativePrior.distributions],
    ['Inside Fund — Cumulative LP Amount (Including Current Notice) — Contributions', lp.insideFund.cumulativeIncluding.contributions],
    ['Inside Fund — Cumulative LP Amount (Including Current Notice) — Distributions', lp.insideFund.cumulativeIncluding.distributions],
    ['Outside Fund — Outflow from LP', lp.outsideFund.outflowFromLp],
    ['Outside Fund — Inflow to LP', lp.outsideFund.inflowToLp],
    ['Outside Fund — Net Cash Flow', lp.outsideFund.net],
    ['LP Total Net Amount Called / (Distributed)', lp.totalNet],
    [],
    ['Unfunded commitment'],
    ['LP Unfunded Balance (Prior to Current Notice)', lp.unfunded.prior],
    ['Impact on LP Unfunded Balance (Current Notice)', lp.unfunded.impact],
    ['Expired/Released Commitments', lp.unfunded.expiredReleased],
    ['Other Unfunded Adjustment', lp.unfunded.otherAdjustment],
    ['LP Unfunded Balance (Including Current Notice)', lp.unfunded.after],
    [],
    ['Transactions'],
    ['Transaction Description', 'Transaction Type', 'LP Amount', 'Impact on Unfunded Commitment', 'Impact on Unfunded Commitment (Value)', 'Net Amount Called / (Distributed)', 'Inside / Outside Fund'],
    ...n.transactions.map(t => [t.description, t.type, t.lpAmount, t.impact, t.impactValue, t.netAmount, t.insideOutside]),
  ]
  if (n.footnotes.length) rows.push([], ['Notes'], ...n.footnotes.map(f => [f]))
  return rows
}
