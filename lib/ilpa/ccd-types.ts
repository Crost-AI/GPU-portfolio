// The ILPA Capital Call & Distribution Template (v. 2.0, September 2025): its transaction types and
// the arithmetic its workbook applies to them. Pure: no I/O.
//
// The names are ILPA's, spelled exactly as the template's dropdown spells them, because an LP's
// system matches on the string. They are the vocabulary, not ILPA's workbook: the file this app
// produces is its own layout, carrying the template's fields (lib/ilpa/ccd.ts).
//
// Two rules from the template's formulas live here so nothing else re-derives them:
//
//   * SIGN. Amounts are entered positive. A capital call, "Distribution: Carry" and "Distribution:
//     Tax Withheld" count as called from the LP; every other type counts as distributed. (Carry and
//     tax withheld are amounts kept back from an LP's distribution, so they reduce what is paid.)
//   * UNFUNDED. Each line states its own impact on the LP's unfunded commitment — Increase,
//     Decrease or No Impact. There is no "recallable" type: a recallable distribution is a
//     distribution line whose impact is Increase.

export const ILPA_CCD_VERSION = '2.0'

/** The credit every CC&D file carries: ILPA created the template it follows, and does not endorse this software. */
export const ILPA_CCD_ATTRIBUTION =
  `This file follows the ILPA Capital Call & Distribution Template (v. ${ILPA_CCD_VERSION}), created by the Institutional ` +
  'Limited Partners Association (ILPA), with thanks to ILPA for developing it as an industry standard. The template is ' +
  "ILPA's; this software is not affiliated with or endorsed by ILPA."

export const CCD_TRANSACTION_TYPES = [
  'Capital Call: Deemed GP Contribution from LPs',
  'Capital Call: Total Amount - Inside Fund',
  'Capital Call: Total Amount - Outside Fund',
  'Capital Call: Investments',
  'Capital Call: Management Fees',
  'Capital Call: Partnership Expenses',
  'Capital Call: Placement Agent Fees',
  'Capital Call: Subsequent Close Interest',
  'Capital Call: Working Capital',
  'Capital Call: Fund-level Subscription Facility Fees/Interest',
  'Capital Call: Other (Provide explanation in far-left column)',
  'Distribution: Carry',
  'Distribution: Clawback',
  'Distribution: Income',
  'Distribution: Dividends',
  'Distribution: Other (Provide explanation in far-left column)',
  'Distribution: Realized Gain / (Loss) - Cash (input negative value for loss)',
  'Distribution: Realized Gain / (Loss) - Stock (input negative value for loss)',
  'Distribution: Return of Capital - Cash',
  'Distribution: Return of Capital - Stock',
  'Distribution: From NAV-Based Facility',
  'Negative Contribution: Return of Excess Capital Called',
  'Negative Contribution: Return of Excess Capital Called - Investments',
  'Negative Contribution: Return of Excess Capital Called - Management Fees/Partnership Expenses',
  'Distribution: Subsequent Close Interest',
  'Distribution: Tax Withheld',
  'Distribution: Refund of Tax Withheld',
] as const

export type CcdTransactionType = typeof CCD_TRANSACTION_TYPES[number]

export type CcdUnfundedImpact = 'Increase' | 'Decrease' | 'No Impact'
export type CcdInsideOutside = 'Inside' | 'Outside'

/** Which column of the template's summary a type lands in. */
export type CcdColumn = 'contribution' | 'distribution'

/** Called from the LP (+) or distributed to them (−), per the template's Net Amount formula. */
export function ccdNetSign(type: CcdTransactionType): 1 | -1 {
  if (type.startsWith('Capital Call:')) return 1
  if (type === 'Distribution: Carry' || type === 'Distribution: Tax Withheld') return 1
  return -1
}

/**
 * The summary column a type is totalled in. Capital calls and negative contributions are
 * contributions (a return of excess capital called reduces paid-in; it is not a distribution);
 * everything else is a distribution, carry and tax withheld included.
 */
export function ccdColumn(type: CcdTransactionType): CcdColumn {
  return type.startsWith('Capital Call:') || type.startsWith('Negative Contribution:') ? 'contribution' : 'distribution'
}

/** The signed change to unfunded commitment a line states. */
export function ccdImpactValue(impact: CcdUnfundedImpact, amount: number): number {
  if (impact === 'Increase') return Math.abs(amount)
  if (impact === 'Decrease') return -Math.abs(amount)
  return 0
}
