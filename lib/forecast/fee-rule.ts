// The management fee, as a plan rule (plans/plan-unified-plan.md §1.3).
//
// One formula, construction's: each forward year (1 = the twelve months after the as-of month) is
// charged at its own rate on its basis — committed capital, capital invested, or NAV — for the
// term, stepping down where the terms say, and only on the fee-paying share of commitments (the
// GP's own stake pays no fee). The yearly figure is what construction's capital planning reads; the
// monthly one (a year spread evenly over its months, to the cent) is what the forecast books.
//
// Kept identical to what construction computed from its own fee inputs, so moving the fee onto the
// plan changes no number.

import { roundCents } from '@/lib/accounting/ledger'
import { DEFAULT_ASSUMPTIONS, projectFeesForYear } from '@/lib/accounting/construction'
import { addMonths, type MonthKey } from './months'
import type { ManagementFeeParams } from './rules'

export interface FeeInputs {
  /** The month construction measures from (its as-of). */
  asOfMonth: MonthKey
  committed: number
  deployedTotal: number
  nav: number
  /** Share of commitments that pays fees (0–1). */
  feePayingShare: number
  /** No fee after this forward year — the fund's last modelled exit. Null = the whole term. */
  lastOperatingYear?: number | null
}

const asAssumptions = (p: ManagementFeeParams) => ({
  ...DEFAULT_ASSUMPTIONS,
  feeAnnualRate: p.rate,
  feeBasis: p.basis,
  feeTermYears: p.termYears,
  feeStepDownYear: p.stepDownYear ?? null,
  feeStepDownRate: p.stepDownRate ?? null,
})

/** The fee in each forward year 1…term (index = year; 0 unused). */
export function managementFeeByYear(p: ManagementFeeParams, f: FeeInputs): number[] {
  const years = Math.ceil(p.termYears)
  const out: number[] = [0]
  const a = asAssumptions(p)
  const share = Math.min(1, Math.max(0, f.feePayingShare))
  for (let y = 1; y <= years; y++) {
    const operating = f.lastOperatingYear == null || y <= f.lastOperatingYear
    out.push(operating ? roundCents(projectFeesForYear(a, f.committed, f.deployedTotal, f.nav, y) * share) : 0)
  }
  return out
}

/** The fee by calendar month: each forward year spread evenly over its twelve months, to the cent. */
export function managementFeeByMonth(p: ManagementFeeParams, f: FeeInputs): Map<MonthKey, number> {
  const out = new Map<MonthKey, number>()
  managementFeeByYear(p, f).forEach((annual, y) => {
    if (y === 0 || !annual) return
    const parts = Array.from({ length: 12 }, () => roundCents(annual / 12))
    parts[11] = roundCents(annual - parts.slice(0, 11).reduce((s, v) => s + v, 0))
    parts.forEach((amount, i) => { if (amount) out.set(addMonths(f.asOfMonth, 12 * y - 11 + i), amount) })
  })
  return out
}

/** A plan's fee rule made from construction's old fee inputs — the one-time move onto the plan. */
export function feeRuleFromConstruction(a: { feeAnnualRate: number; feeBasis: string; feeTermYears: number; feeStepDownYear: number | null; feeStepDownRate: number | null }): ManagementFeeParams | null {
  if (!(a.feeAnnualRate > 0) || !(a.feeTermYears > 0)) return null
  const basis = a.feeBasis === 'invested' || a.feeBasis === 'nav' ? a.feeBasis : 'committed'
  return { rate: a.feeAnnualRate, basis, termYears: a.feeTermYears, stepDownYear: a.feeStepDownYear, stepDownRate: a.feeStepDownRate }
}
