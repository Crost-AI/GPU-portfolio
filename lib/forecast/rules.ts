// Account rules: how one account's monthly amount is produced.
//
// Every evaluator returns amounts on the account's NORMAL side — revenue and expense both
// positive — because that is how a person states a budget ("$12,000 of tax prep"). The
// compiler turns them into signed, balanced postings; nothing here knows about debits.
//
// A month with no amount is absent from the result, not zero. "We don't know" and "nothing
// happens" are different answers, and only the rule can say which one it means.

import { roundCents } from '@/lib/accounting/ledger'
import { addMonths, isMonthKey, monthDiff, parseMonth, type MonthKey } from './months'

export type RuleMethod =
  | 'manual'
  | 'fixed'
  | 'recurring'
  | 'run_rate'
  | 'growth'
  | 'seasonal'
  | 'linked_fee'
  | 'linked_construction'
  | 'management_fee'
  | 'linked_fleet'

export const RULE_METHODS: RuleMethod[] = ['manual', 'fixed', 'recurring', 'run_rate', 'growth', 'seasonal', 'linked_fee', 'linked_construction', 'management_fee', 'linked_fleet']

/** Methods the engine can evaluate today. Linked drivers arrive with their source mappings. */
export const SUPPORTED_METHODS: RuleMethod[] = RULE_METHODS

/** Methods whose amounts come from another part of the app, supplied by the service, not evaluated here. */
export const LINKED_METHODS: RuleMethod[] = ['linked_fee', 'linked_construction', 'management_fee', 'linked_fleet']

/**
 * A fund's management fee, owned by the plan (plans/plan-unified-plan.md §1.3): the rate on a basis,
 * for a term of years from now, optionally stepping down. Charged on the fee-paying share of
 * commitments (the GP's own stake is exempt). Evaluated by lib/forecast/fee-rule.ts, which needs the
 * fund's commitments and deployment — so it is supplied by the service, like the linked methods.
 */
export interface ManagementFeeParams {
  /** Annual rate, e.g. 0.02. */
  rate: number
  basis: 'committed' | 'invested' | 'nav'
  /** Years of fees from now. */
  termYears: number
  /** The forward year (1-based) from which `stepDownRate` applies. */
  stepDownYear?: number | null
  stepDownRate?: number | null
}

export interface LinkedFeeParams {
  /** Only this managed fund (by name). Omitted on a manco = every linked fund; on a fund = its link. */
  fundVehicle?: string
}

export interface LinkedConstructionParams {
  /** Which of the construction model's operating flows this account carries. */
  flow: 'fees' | 'expenses'
}

/**
 * A GPU SPV's fleet flows, from the plan's fleet scenario (lib/gpu/scenario.ts runFleetScenario):
 * each plan-year figure spread evenly over its twelve months. `depreciation` and `disposal` are not
 * cash: they compile to their own entries (lib/forecast/plan.ts fleetEntries).
 */
export const FLEET_FLOWS = ['revenue', 'processing_fee', 'datacenter', 'contingency', 'insurance', 'depreciation', 'disposal', 'fee'] as const
export type FleetFlow = (typeof FLEET_FLOWS)[number]

export interface LinkedFleetParams {
  flow: FleetFlow
}

export interface ManualParams {
  amounts: Record<MonthKey, number>
}

export interface FixedParams {
  amount: number
  /** First and last month the amount applies (inclusive). Open-ended when omitted. */
  start?: MonthKey
  end?: MonthKey
}

export interface RecurringParams {
  amount: number
  /** 1 = monthly, 3 = quarterly, 6 = semiannual, 12 = annual. */
  everyMonths: number
  /** A month the charge lands in; the cadence runs forwards and backwards from it. */
  anchor: MonthKey
  start?: MonthKey
  end?: MonthKey
  /** Increase applied once per full year after the anchor, e.g. 0.03. */
  annualEscalation?: number
  /** Occurrences to skip. */
  exceptions?: MonthKey[]
  /** Additional one-off amounts, added on top of any regular occurrence. */
  oneOffs?: { month: MonthKey; amount: number }[]
}

export interface RunRateParams {
  /** Trailing closed months to average. */
  window?: 3 | 6 | 12
  /** A custom history window instead of the trailing one. */
  from?: MonthKey
  to?: MonthKey
  /** Count actual months that are not closed yet. Off by default: an open month is not final. */
  includeUnclosed?: boolean
}

export interface GrowthParams {
  /** The amount in `baseMonth`. */
  base: number
  baseMonth: MonthKey
  /** Rate per `per`, e.g. 0.05. */
  rate: number
  /** 'month' compounds every month; 'year' steps once every 12 months from baseMonth. */
  per: 'month' | 'year'
}

export interface SeasonalParams {
  /** Amount by calendar month, '1'…'12'. A missing month is nothing that month. */
  profile: Record<string, number>
  /** First month the profile applies as stated; each 12 months after it, growth applies once. */
  anchor: MonthKey
  /** Year-on-year change, e.g. 0.04. */
  annualGrowth?: number
}

export interface RuleInput {
  method: RuleMethod
  params: unknown
}

export interface HistoryContext {
  /** Actual natural-side activity for this account by month. Months with no postings are absent. */
  actuals: ReadonlyMap<MonthKey, number>
  /**
   * The closed span of the books. Months before `closedFrom` predate the books (missing, not
   * zero); months after `closedThrough` are open. Null when nothing is closed.
   */
  closedFrom: MonthKey | null
  closedThrough: MonthKey | null
  /** Last month of actuals the plan uses. */
  cutoff: MonthKey | null
}

export interface RuleResult {
  amounts: Map<MonthKey, number>
  /** Human-readable account of what the numbers rest on — shown on drill-down. */
  basis: string
  warnings: string[]
}

export class RuleError extends Error {}

const num = (v: unknown, field: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new RuleError(`${field} must be a number`)
  return v
}

/**
 * The largest amount a rule may state or produce for one month. Entries are stored as numeric(20,2)
 * (under 1e18); this leaves room for sums across months and accounts, and is far past any real fund.
 */
export const MAX_AMOUNT = 1e13
/** Most entries a rule's lists (manual months, exceptions, one-offs) may hold. */
export const MAX_RULE_ITEMS = 1200

const amount = (v: unknown, field: string): number => {
  const n = num(v, field)
  if (Math.abs(n) > MAX_AMOUNT) throw new RuleError(`${field} is too large (at most ${MAX_AMOUNT.toLocaleString('en-US')})`)
  return n
}

const list = (v: unknown[], field: string): unknown[] => {
  if (v.length > MAX_RULE_ITEMS) throw new RuleError(`${field} has too many entries (at most ${MAX_RULE_ITEMS})`)
  return v
}

/** A computed amount, or null when growth has carried it past what can be stored. */
const bounded = (n: number): number | null => (Number.isFinite(n) && Math.abs(n) <= MAX_AMOUNT ? roundCents(n) : null)
const TOO_LARGE = `Amounts past ${MAX_AMOUNT.toLocaleString('en-US')} a month are left out — check the rate and the start month`

const month = (v: unknown, field: string): MonthKey => {
  if (!isMonthKey(v)) throw new RuleError(`${field} must be a month (YYYY-MM)`)
  return v
}

const optMonth = (v: unknown, field: string): MonthKey | undefined => (v == null ? undefined : month(v, field))

const obj = (p: unknown): Record<string, unknown> => {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new RuleError('params must be an object')
  return p as Record<string, unknown>
}

/**
 * Validate and normalise a rule's params. Throws RuleError with the field at fault. This is
 * the one validator — routes, MCP tools and staged Analyst actions all call it.
 */
export function validateRule(method: unknown, raw: unknown): RuleInput {
  if (typeof method !== 'string' || !RULE_METHODS.includes(method as RuleMethod)) {
    throw new RuleError(`method must be one of ${RULE_METHODS.join(', ')}`)
  }
  const m = method as RuleMethod
  if (!SUPPORTED_METHODS.includes(m)) throw new RuleError(`${m} is not available yet`)
  const p = obj(raw)
  switch (m) {
    case 'manual': {
      const amounts = obj(p.amounts ?? {})
      const out: Record<MonthKey, number> = {}
      for (const [k, v] of list(Object.entries(amounts), 'amounts') as [string, unknown][]) out[month(k, 'amounts key')] = roundCents(amount(v, `amounts.${k}`))
      return { method: m, params: { amounts: out } satisfies ManualParams }
    }
    case 'fixed': {
      const params: FixedParams = {
        amount: roundCents(amount(p.amount, 'amount')),
        start: optMonth(p.start, 'start'),
        end: optMonth(p.end, 'end'),
      }
      if (params.start && params.end && params.start > params.end) throw new RuleError('start is after end')
      return { method: m, params }
    }
    case 'recurring': {
      const every = num(p.everyMonths, 'everyMonths')
      if (!Number.isInteger(every) || every < 1 || every > 120) throw new RuleError('everyMonths must be a whole number from 1 to 120')
      const esc = p.annualEscalation == null ? undefined : num(p.annualEscalation, 'annualEscalation')
      if (esc != null && (esc <= -1 || esc > 10)) throw new RuleError('annualEscalation is out of range')
      const exceptions = Array.isArray(p.exceptions) ? list(p.exceptions, 'exceptions').map((e, i) => month(e, `exceptions[${i}]`)) : undefined
      const oneOffs = Array.isArray(p.oneOffs)
        ? list(p.oneOffs, 'oneOffs').map((o, i) => {
            const oo = obj(o)
            return { month: month(oo.month, `oneOffs[${i}].month`), amount: roundCents(amount(oo.amount, `oneOffs[${i}].amount`)) }
          })
        : undefined
      const params: RecurringParams = {
        amount: roundCents(amount(p.amount, 'amount')),
        everyMonths: every,
        anchor: month(p.anchor, 'anchor'),
        start: optMonth(p.start, 'start'),
        end: optMonth(p.end, 'end'),
        annualEscalation: esc,
        exceptions,
        oneOffs,
      }
      if (params.start && params.end && params.start > params.end) throw new RuleError('start is after end')
      return { method: m, params }
    }
    case 'run_rate': {
      const hasCustom = p.from != null || p.to != null
      const params: RunRateParams = { includeUnclosed: p.includeUnclosed === true }
      if (hasCustom) {
        params.from = month(p.from, 'from')
        params.to = month(p.to, 'to')
        if (params.from > params.to) throw new RuleError('from is after to')
      } else {
        const w = p.window ?? 12
        if (w !== 3 && w !== 6 && w !== 12) throw new RuleError('window must be 3, 6 or 12')
        params.window = w
      }
      return { method: m, params }
    }
    case 'linked_fee': {
      const params: LinkedFeeParams = {}
      if (p.fundVehicle != null) {
        if (typeof p.fundVehicle !== 'string' || !p.fundVehicle.trim()) throw new RuleError('fundVehicle must be a vehicle name')
        params.fundVehicle = p.fundVehicle.trim()
      }
      return { method: m, params }
    }
    case 'linked_construction': {
      if (p.flow !== 'fees' && p.flow !== 'expenses') throw new RuleError("flow must be 'fees' or 'expenses'")
      return { method: m, params: { flow: p.flow } satisfies LinkedConstructionParams }
    }
    case 'linked_fleet': {
      if (!FLEET_FLOWS.includes(p.flow as FleetFlow)) throw new RuleError(`flow must be one of ${FLEET_FLOWS.join(', ')}`)
      return { method: m, params: { flow: p.flow as FleetFlow } satisfies LinkedFleetParams }
    }
    case 'management_fee': {
      const rate = num(p.rate, 'rate')
      if (rate < 0 || rate > 0.2) throw new RuleError('rate is an annual fraction between 0 and 0.2 (0.02 = 2%)')
      if (p.basis !== 'committed' && p.basis !== 'invested' && p.basis !== 'nav') throw new RuleError("basis must be 'committed', 'invested' or 'nav'")
      const termYears = num(p.termYears, 'termYears')
      if (termYears < 0 || termYears > 20) throw new RuleError('termYears must be 0–20')
      const stepDownYear = p.stepDownYear == null || p.stepDownYear === '' ? null : num(p.stepDownYear, 'stepDownYear')
      const stepDownRate = p.stepDownRate == null || p.stepDownRate === '' ? null : num(p.stepDownRate, 'stepDownRate')
      if (stepDownYear != null && (stepDownYear < 1 || stepDownYear > 20)) throw new RuleError('stepDownYear must be 1–20')
      if (stepDownRate != null && (stepDownRate < 0 || stepDownRate > 0.2)) throw new RuleError('stepDownRate is an annual fraction between 0 and 0.2')
      return { method: m, params: { rate, basis: p.basis, termYears, stepDownYear, stepDownRate } satisfies ManagementFeeParams }
    }
    case 'seasonal': {
      const prof = obj(p.profile)
      const profile: Record<string, number> = {}
      for (const [k, v] of Object.entries(prof)) {
        const n = Number(k)
        if (!Number.isInteger(n) || n < 1 || n > 12) throw new RuleError('profile keys are calendar months 1–12')
        profile[String(n)] = roundCents(amount(v, `profile.${k}`))
      }
      const g = p.annualGrowth == null ? undefined : num(p.annualGrowth, 'annualGrowth')
      if (g != null && (g <= -1 || g > 10)) throw new RuleError('annualGrowth is out of range')
      return { method: m, params: { profile, anchor: month(p.anchor, 'anchor'), annualGrowth: g } satisfies SeasonalParams }
    }
    case 'growth': {
      if (p.per !== 'month' && p.per !== 'year') throw new RuleError("per must be 'month' or 'year'")
      const rate = num(p.rate, 'rate')
      if (rate <= -1 || rate > 10) throw new RuleError('rate is out of range')
      // Compounding monthly, 100% a month already doubles it every month.
      if (p.per === 'month' && rate > 1) throw new RuleError('rate per month is at most 1 (100%)')
      const params: GrowthParams = {
        base: roundCents(amount(p.base, 'base')),
        baseMonth: month(p.baseMonth, 'baseMonth'),
        rate,
        per: p.per,
      }
      return { method: m, params }
    }
    default:
      throw new RuleError(`${m} is not available yet`)
  }
}

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })

const inWindow = (m: MonthKey, start?: MonthKey, end?: MonthKey) => (!start || m >= start) && (!end || m <= end)

/** Evaluate a validated rule over the target months. */
export function evaluateRule(rule: RuleInput, months: MonthKey[], history: HistoryContext): RuleResult {
  const amounts = new Map<MonthKey, number>()
  const warnings: string[] = []

  switch (rule.method) {
    case 'manual': {
      const p = rule.params as ManualParams
      for (const m of months) if (p.amounts[m] != null) amounts.set(m, p.amounts[m])
      return { amounts, basis: 'Entered by month', warnings }
    }

    case 'fixed': {
      const p = rule.params as FixedParams
      for (const m of months) if (inWindow(m, p.start, p.end)) amounts.set(m, p.amount)
      return { amounts, basis: `${fmt(p.amount)} every month`, warnings }
    }

    case 'recurring': {
      const p = rule.params as RecurringParams
      const skip = new Set(p.exceptions ?? [])
      for (const m of months) {
        if (!inWindow(m, p.start, p.end)) continue
        const offset = monthDiff(p.anchor, m)
        let amount = 0
        if (offset % p.everyMonths === 0 && !skip.has(m)) {
          const years = Math.floor(offset / 12)
          amount = p.amount * Math.pow(1 + (p.annualEscalation ?? 0), Math.max(0, years))
        }
        for (const o of p.oneOffs ?? []) if (o.month === m) amount += o.amount
        const v = bounded(amount)
        if (v == null) { if (!warnings.includes(TOO_LARGE)) warnings.push(TOO_LARGE); continue }
        if (v !== 0) amounts.set(m, v)
      }
      const { month: anchorMonth } = parseMonth(p.anchor)
      const cadence = p.everyMonths === 1 ? 'every month' : p.everyMonths === 12 ? 'every year' : `every ${p.everyMonths} months`
      const esc = p.annualEscalation ? `, +${fmt(p.annualEscalation * 100)}%/yr` : ''
      return {
        amounts,
        basis: `${fmt(p.amount)} ${cadence} from ${p.anchor} (month ${anchorMonth})${esc}`,
        warnings,
      }
    }

    case 'run_rate': {
      const p = rule.params as RunRateParams
      const last = history.cutoff
      if (!last) {
        return { amounts, basis: 'Run rate — no actuals', warnings: ['No actuals before the cutoff to average'] }
      }
      const from = p.from ?? addMonths(last, -((p.window ?? 12) - 1))
      const to = p.to ?? last
      const eligible: MonthKey[] = []
      const excluded: MonthKey[] = []
      for (let m = from; m <= to; m = addMonths(m, 1)) {
        if (m > last) break
        if (history.closedFrom != null && m < history.closedFrom) continue
        const closed = history.closedThrough != null && m <= history.closedThrough
        if (closed || p.includeUnclosed) eligible.push(m)
        else excluded.push(m)
      }
      if (excluded.length > 0) {
        warnings.push(`Left out ${excluded.length} unclosed month${excluded.length === 1 ? '' : 's'} (${excluded[0]}${excluded.length > 1 ? `–${excluded[excluded.length - 1]}` : ''})`)
      }
      if (eligible.length === 0) {
        warnings.push('No eligible months to average')
        return { amounts, basis: `Run rate over ${from}–${to} — nothing eligible`, warnings }
      }
      const expected = monthDiff(from, to) + 1
      if (eligible.length < expected) warnings.push(`Averaged ${eligible.length} of ${expected} months`)
      // A closed month with no postings to this account is a real zero — the books for it are final.
      const total = eligible.reduce((s, m) => s + (history.actuals.get(m) ?? 0), 0)
      const avg = roundCents(total / eligible.length)
      for (const m of months) amounts.set(m, avg)
      return {
        amounts,
        basis: `Average of ${eligible.length} month${eligible.length === 1 ? '' : 's'} ${eligible[0]}–${eligible[eligible.length - 1]}: ${fmt(avg)}/mo`,
        warnings,
      }
    }

    case 'seasonal': {
      const p = rule.params as SeasonalParams
      for (const m of months) {
        const base = p.profile[String(parseMonth(m).month)]
        if (!base) continue
        const years = Math.max(0, Math.floor(monthDiff(p.anchor, m) / 12))
        const v = bounded(base * Math.pow(1 + (p.annualGrowth ?? 0), years))
        if (v == null) { if (!warnings.includes(TOO_LARGE)) warnings.push(TOO_LARGE); continue }
        amounts.set(m, v)
      }
      const g = p.annualGrowth ? `, +${fmt(p.annualGrowth * 100)}%/yr` : ''
      return { amounts, basis: `Repeats a 12-month profile (${fmt(Object.values(p.profile).reduce((a, b) => a + b, 0))}/yr) from ${p.anchor}${g}`, warnings }
    }

    case 'growth': {
      const p = rule.params as GrowthParams
      for (const m of months) {
        const d = monthDiff(p.baseMonth, m)
        if (d < 0) continue
        const steps = p.per === 'month' ? d : Math.floor(d / 12)
        const v = bounded(p.base * Math.pow(1 + p.rate, steps))
        if (v == null) { if (!warnings.includes(TOO_LARGE)) warnings.push(TOO_LARGE); continue }
        amounts.set(m, v)
      }
      return {
        amounts,
        basis: `${fmt(p.base)} in ${p.baseMonth}, +${fmt(p.rate * 100)}% per ${p.per}`,
        warnings,
      }
    }

    default:
      // Linked methods are evaluated by the service from their sources (lib/forecast/linked.ts).
      return { amounts, basis: rule.method, warnings: [`${rule.method} has no linked source loaded`] }
  }
}
