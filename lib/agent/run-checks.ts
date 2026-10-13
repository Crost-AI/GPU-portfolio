// What should be true of the books after a run (lib/agent/run-action.ts): the assistant states it
// when it stages the run, the approver reads it before approving, and the run checks it once its
// steps are applied.
//
// Deliberately small. Three kinds, each read through the same posted-ledger loader and trial
// balance the `financial_statements` tool uses, for a vehicle resolved the way that tool resolves
// it, with the APPROVER's access. A check only reads: it can fail, it can never change anything.

import { hasAccess } from '@/lib/access/effective'
import type { AccountType } from '@/lib/accounting/types'
import { getTool, resolveVehicleForTool } from '@/lib/accounting/agent-tools'
import { loadPostedLedger } from '@/lib/accounting/load'
import { trialBalance } from '@/lib/accounting/statements'
import type { ActionDeps } from '@/lib/pending-actions/types'

export const MAX_RUN_CHECKS = 50
const DEFAULT_TOLERANCE = 0.01
const ACCOUNT_TYPES: AccountType[] = ['asset', 'liability', 'equity', 'income', 'expense']
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 *  - `account_balance`: one account's balance, on its normal side (an asset's debit balance, a
 *    liability's credit balance), equals a figure.
 *  - `type_total`: the total of every account of one type (all assets, all income) equals a figure.
 *  - `trial_balance`: debits equal credits.
 * Each reads posted entries only, through `asOf` when given.
 */
export type RunCheck =
  | { kind: 'account_balance'; vehicle?: string; account: string; asOf?: string; equals: number; tolerance?: number; label?: string }
  | { kind: 'type_total'; vehicle?: string; accountType: AccountType; asOf?: string; equals: number; tolerance?: number; label?: string }
  | { kind: 'trial_balance'; vehicle?: string; asOf?: string; label?: string }

export interface CheckOutcome {
  label: string
  kind: RunCheck['kind']
  vehicle: string | null
  asOf: string | null
  expected: number | 'balanced'
  actual: number | 'balanced' | 'out of balance' | null
  passed: boolean
  /** Set when the check could not be read at all (an unknown vehicle, no access). */
  error?: string
}

export const RUN_CHECK_SCHEMA = {
  type: 'object',
  required: ['kind'],
  properties: {
    kind: { type: 'string', enum: ['account_balance', 'type_total', 'trial_balance'] },
    vehicle: { type: 'string', description: 'the vehicle whose books to read; optional on a single-vehicle fund' },
    account: { type: 'string', description: 'account_balance: the account code, e.g. "1200"' },
    accountType: { type: 'string', enum: ACCOUNT_TYPES, description: 'type_total: which accounts to total' },
    asOf: { type: 'string', description: 'ISO date; posted entries on or before it (default: all)' },
    equals: { type: 'number', description: 'the expected balance or total, on the normal side' },
    tolerance: { type: 'number', description: `allowed difference (default ${DEFAULT_TOLERANCE})` },
    label: { type: 'string', description: 'what this check is for, in a few words' },
  },
}

/** Parse the `expected` array of a staged run. Problems are returned, not thrown. */
export function parseChecks(raw: unknown): { checks: RunCheck[]; problems: string[] } {
  if (raw === undefined || raw === null) return { checks: [], problems: [] }
  if (!Array.isArray(raw)) return { checks: [], problems: ['expected must be a list of checks.'] }
  if (raw.length > MAX_RUN_CHECKS) return { checks: [], problems: [`At most ${MAX_RUN_CHECKS} expected checks.`] }
  const checks: RunCheck[] = []
  const problems: string[] = []
  raw.forEach((c: any, i) => {
    const at = `expected[${i}]`
    if (!c || typeof c !== 'object') { problems.push(`${at} must be an object.`); return }
    const vehicle = optionalString(c.vehicle)
    const label = optionalString(c.label)?.slice(0, 200)
    const asOf = optionalString(c.asOf)
    if (asOf && !ISO_DATE.test(asOf)) problems.push(`${at}.asOf must be an ISO date (YYYY-MM-DD).`)
    const tolerance = c.tolerance === undefined ? undefined : Number(c.tolerance)
    if (tolerance !== undefined && !(Number.isFinite(tolerance) && tolerance >= 0)) problems.push(`${at}.tolerance must be zero or more.`)
    const base = { ...(vehicle ? { vehicle } : {}), ...(asOf ? { asOf } : {}), ...(label ? { label } : {}) }
    if (c.kind === 'trial_balance') { checks.push({ kind: 'trial_balance', ...base }); return }
    if (c.kind !== 'account_balance' && c.kind !== 'type_total') {
      problems.push(`${at}.kind must be account_balance, type_total or trial_balance.`)
      return
    }
    if (typeof c.equals !== 'number' || !Number.isFinite(c.equals)) { problems.push(`${at}.equals must be a number.`); return }
    const withTolerance = tolerance !== undefined ? { tolerance } : {}
    if (c.kind === 'account_balance') {
      const account = optionalString(c.account)
      if (!account) { problems.push(`${at}.account (an account code) is required.`); return }
      checks.push({ kind: 'account_balance', account, equals: c.equals, ...withTolerance, ...base })
      return
    }
    if (!ACCOUNT_TYPES.includes(c.accountType)) { problems.push(`${at}.accountType must be one of ${ACCOUNT_TYPES.join(', ')}.`); return }
    checks.push({ kind: 'type_total', accountType: c.accountType, equals: c.equals, ...withTolerance, ...base })
  })
  return { checks, problems }
}

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/** The check in words, for the approver. */
export function describeCheck(c: RunCheck): string {
  const where = `${c.vehicle ? ` on ${c.vehicle}` : ''}${c.asOf ? ` as of ${c.asOf}` : ''}`
  const what = c.kind === 'account_balance'
    ? `Account ${c.account} balance${where} is ${fmt(c.equals)}`
    : c.kind === 'type_total'
      ? `Total ${c.accountType}${where} is ${fmt(c.equals)}`
      : `Trial balance${where} balances`
  return c.label ? `${c.label}: ${what}` : what
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

const round = (n: number) => Math.round(n * 100) / 100

/**
 * Read each check's vehicle the way `financial_statements` does, with the given access (the
 * approver's at evaluation, the stager's at staging). Throws when it is not theirs.
 */
export async function resolveCheckVehicle(deps: ActionDeps, check: RunCheck): Promise<string> {
  if (!hasAccess(deps.access, 'accounting', 'read')) throw new Error('Checking the books needs read access to Fund accounting.')
  return resolveVehicleForTool(getTool('financial_statements')!, deps.admin, deps.fundId, check.vehicle, deps.access)
}

/** Evaluate every check. Never throws: a check that cannot be read is a failed check, with why. */
export async function evaluateChecks(deps: ActionDeps, checks: RunCheck[]): Promise<CheckOutcome[]> {
  const out: CheckOutcome[] = []
  for (const check of checks) {
    const expected = check.kind === 'trial_balance' ? 'balanced' as const : check.equals
    const label = describeCheck(check)
    try {
      const vehicle = await resolveCheckVehicle(deps, check)
      const { accounts, postings } = await loadPostedLedger(deps.admin, deps.fundId, vehicle, check.asOf)
      const tb = trialBalance(accounts, postings)
      const asOf = check.asOf ?? null
      if (check.kind === 'trial_balance') {
        out.push({ label, kind: check.kind, vehicle, asOf, expected, actual: tb.balanced ? 'balanced' : 'out of balance', passed: tb.balanced })
        continue
      }
      let actual: number
      if (check.kind === 'account_balance') {
        if (!accounts.some(a => a.code === check.account)) throw new Error(`${vehicle} has no account ${check.account}.`)
        actual = round(tb.rows.find(r => r.code === check.account)?.balance ?? 0)
      } else {
        actual = round(tb.rows.filter(r => r.type === check.accountType).reduce((s, r) => s + r.balance, 0))
      }
      const tolerance = check.tolerance ?? DEFAULT_TOLERANCE
      out.push({ label, kind: check.kind, vehicle, asOf, expected, actual, passed: Math.abs(actual - check.equals) <= tolerance + 1e-9 })
    } catch (e) {
      out.push({
        label, kind: check.kind, vehicle: check.vehicle ?? null, asOf: check.asOf ?? null, expected, actual: null, passed: false,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
  return out
}
