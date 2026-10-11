// A plan's fees and expenses by forward year — what portfolio construction's capital planning reads
// once the plan owns them (plans/plan-unified-plan.md §1.3).
//
// CASH, not accrual: capital planning decides what has to be called, so it counts what leaves the
// bank and when. Each rule's cash timing applies — a prepaid cost (a fee paid up front and expensed
// month by month) needs no cash in the plan; one paid N months after it is incurred lands N months
// later. The P&L (Financials) still shows the expense as it is recognised.
//
// Fees: the plan's management-fee rule (lib/forecast/fee-rule.ts), or whatever rule the plan has on
// the management-fee account (a prepaid fee expensed monthly). Expenses: every other expense
// account's rule. Each is evaluated by month, as the forecast evaluates it, and summed into the
// forward years construction counts in (year 1 = the twelve months after its as-of month).
//
// Null when the plan has no rule on any expense account: construction then keeps its own inputs,
// so an entity whose plan has not taken them over yet shows the same numbers it always did.

import type { PlanCosts } from '@/lib/accounting/construction'
import { SAME_MONTH, type CashTiming } from './compile'
import { managementFeeByMonth, managementFeeByYear, type FeeInputs } from './fee-rule'
import { addMonths, monthDiff, type MonthKey } from './months'
import { evaluateRule, LINKED_METHODS, validateRule, type ManagementFeeParams, type RuleMethod } from './rules'

export interface CostRule { accountId: string; method: RuleMethod; params: unknown; cashTiming?: CashTiming | null }
export interface CostAccount { id: string; type: string; subtype: string | null }

export function planCostsByYear(input: {
  rules: CostRule[]
  accounts: CostAccount[]
  history: Map<string, Map<MonthKey, number>>
  closedFrom: MonthKey | null
  closedThrough: MonthKey | null
  horizonYears: number
  fee: FeeInputs
}): PlanCosts | null {
  const byId = new Map(input.accounts.map(a => [a.id, a]))
  const expenseRules = input.rules.filter(r => byId.get(r.accountId)?.type === 'expense')
  if (expenseRules.length === 0) return null

  const years = Math.max(1, Math.ceil(input.horizonYears))
  const feesByYear = Array.from({ length: years + 1 }, () => 0)
  const expensesByYear = Array.from({ length: years + 1 }, () => 0)
  const months = Array.from({ length: years * 12 }, (_, i) => addMonths(input.fee.asOfMonth, i + 1))
  const yearOf = (m: MonthKey) => Math.ceil(monthDiff(input.fee.asOfMonth, m) / 12)
  const add = (into: number[], m: MonthKey, v: number) => {
    const y = yearOf(m)
    if (y >= 1 && y <= years) into[y] = Math.round((into[y] + v) * 100) / 100
  }

  for (const r of expenseRules) {
    const timing = r.cashTiming ?? SAME_MONTH
    if (timing.mode === 'prepaid') continue // already paid: no cash in the plan
    const lag = timing.mode === 'offset' ? timing.months : 0
    const isFee = r.method === 'management_fee' || byId.get(r.accountId)?.subtype === 'management_fee'
    const into = isFee ? feesByYear : expensesByYear
    if (r.method === 'management_fee') {
      const p = validateRule('management_fee', r.params).params as ManagementFeeParams
      if (lag === 0) {
        managementFeeByYear(p, input.fee).forEach((v, y) => { if (y >= 1 && y <= years) into[y] = Math.round((into[y] + v) * 100) / 100 })
      } else {
        for (const [m, v] of managementFeeByMonth(p, input.fee)) add(into, addMonths(m, lag), v)
      }
      continue
    }
    if (LINKED_METHODS.includes(r.method)) continue // supplied from elsewhere; not a cost of this plan's own
    const res = evaluateRule(validateRule(r.method, r.params), months, {
      actuals: input.history.get(r.accountId) ?? new Map(),
      closedFrom: input.closedFrom,
      closedThrough: input.closedThrough,
      cutoff: input.fee.asOfMonth,
    })
    for (const [m, v] of res.amounts) add(into, addMonths(m, lag), v)
  }
  return { feesByYear, expensesByYear }
}

export { managementFeeByMonth }
