// Recurring fleet opex through accounting_schedules (design §4.4): the datacenter accrual
// (Dr 5100 / Cr 2000), re-created at each escalation date, and the insurance prepaid amortization
// (Dr 5200 / Cr 1500). The close proposes each month's draft from these schedules through the
// existing loadCloseEntrySuggestions; nothing here posts an entry.
//
// The pure half plans the periods; the rest writes the schedule rows. Schedules fall due at month
// end (day_of_month 31, clamped by scheduledMonth), so the grain is a whole month.

import type { SupabaseClient } from '@supabase/supabase-js'
import { addMonths, monthOf } from '@/lib/forecast/months'
import { monthEnd } from './depreciation'
import type { DatacenterContractRow } from './types'

export interface SchedulePeriod {
  start: string
  /** Inclusive; null = open-ended. */
  end: string | null
  amount: number
}

const cents = (n: number) => Math.round(n * 100)
const MONTH_END_DAY = 31

function addYears(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const last = new Date(Date.UTC(y + n, m, 0)).getUTCDate()
  return `${y + n}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
}

function dayBefore(iso: string): string {
  const t = new Date(`${iso}T00:00:00Z`)
  t.setUTCDate(t.getUTCDate() - 1)
  return t.toISOString().slice(0, 10)
}

type ContractTerms = Pick<DatacenterContractRow, 'start_date' | 'end_date' | 'monthly_fee' | 'escalator_pct' | 'escalates_on' | 'first_escalation_date'>

/**
 * Escalation dates up to `through` (inclusive). The first is `first_escalation_date` when set, else
 * the contract's first anniversary or the next 1 January; then yearly. None after the contract ends,
 * and none at all without an escalator.
 */
export function escalationDates(c: ContractTerms, through: string): string[] {
  if (!(Number(c.escalator_pct) > 0)) return []
  const first = c.first_escalation_date
    ?? (c.escalates_on === 'calendar_year' ? `${Number(c.start_date.slice(0, 4)) + 1}-01-01` : addYears(c.start_date, 1))
  const out: string[] = []
  for (let n = 0, d = first; d <= through && (!c.end_date || d <= c.end_date); d = addYears(first, ++n)) out.push(d)
  return out
}

/** The monthly fee in force on `date`: monthly_fee × (1 + escalator)^(escalations so far), in cents. */
export function datacenterFeeOn(c: ContractTerms, date: string): number {
  const n = escalationDates(c, date).length
  return cents(Number(c.monthly_fee) * Math.pow(1 + Number(c.escalator_pct), n)) / 100
}

/** The contract split at its escalation dates, through `through`. The last period stays open. */
export function datacenterPeriods(c: ContractTerms, through: string): SchedulePeriod[] {
  const starts = [c.start_date, ...escalationDates(c, through)]
  return starts.map((start, i) => ({
    start,
    end: i + 1 < starts.length ? dayBefore(starts[i + 1]) : c.end_date ?? null,
    amount: datacenterFeeOn(c, start),
  }))
}

/**
 * Amortize a prepaid premium over `months` from `startDate`'s month: one schedule at
 * round(premium / months), and a one-month schedule for the final month carrying the remainder
 * when it does not divide (a schedule holds one fixed amount).
 */
export function insurancePeriods(premium: number, startDate: string, months: number): SchedulePeriod[] {
  const total = cents(premium)
  if (total <= 0 || months <= 0) return []
  const monthly = Math.round(total / months)
  const first = monthOf(startDate)
  const lastMonth = addMonths(first, months - 1)
  const final = total - monthly * (months - 1)
  if (final === monthly) return [{ start: startDate, end: monthEnd(lastMonth), amount: monthly / 100 }]
  const out: SchedulePeriod[] = []
  if (months > 1) out.push({ start: startDate, end: monthEnd(addMonths(first, months - 2)), amount: monthly / 100 })
  out.push({ start: months > 1 ? `${lastMonth}-01` : startDate, end: monthEnd(lastMonth), amount: final / 100 })
  return out
}

/** The contract terms a caller may set. Fee, escalator and dates are fixed once a schedule exists. */
export type ContractInput = Partial<Pick<DatacenterContractRow,
  'facility' | 'vendor_id' | 'start_date' | 'end_date' | 'monthly_fee' | 'escalator_pct' | 'escalates_on' | 'first_escalation_date'
  | 'power_kw' | 'includes_connectivity' | 'deposit' | 'allocation' | 'status'>>

export const CONTRACT_TERMS = ['start_date', 'monthly_fee', 'escalator_pct', 'escalates_on', 'first_escalation_date'] as const

/** Validate a contract create (`partial: false`: facility, start_date and monthly_fee required) or update. */
export function parseContractInput(body: any, partial: boolean): { value: ContractInput } | { error: string } {
  const b = body ?? {}
  const out: ContractInput = {}
  const has = (k: string) => b[k] !== undefined
  const date = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  const nonNeg = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0
  if (has('facility') || !partial) {
    if (typeof b.facility !== 'string' || !b.facility.trim()) return { error: 'facility is required' }
    out.facility = b.facility.trim()
  }
  for (const k of ['start_date', 'end_date', 'first_escalation_date'] as const) {
    if (!has(k) && !(k === 'start_date' && !partial)) continue
    if (k !== 'start_date' && b[k] === null) { out[k] = null; continue }
    if (!date(b[k])) return { error: `${k} must be YYYY-MM-DD` }
    out[k] = b[k]
  }
  for (const k of ['monthly_fee', 'escalator_pct', 'deposit', 'power_kw'] as const) {
    if (!has(k) && !(k === 'monthly_fee' && !partial)) continue
    if ((k === 'deposit' || k === 'power_kw') && b[k] === null) { out[k] = null; continue }
    if (!nonNeg(b[k])) return { error: `${k} must be a number, zero or more` }
    out[k] = b[k]
  }
  if (has('escalates_on')) {
    if (!['anniversary', 'calendar_year'].includes(b.escalates_on)) return { error: 'escalates_on must be anniversary or calendar_year' }
    out.escalates_on = b.escalates_on
  }
  if (has('allocation')) {
    if (!['none', 'gpu_count'].includes(b.allocation)) return { error: 'allocation must be none or gpu_count' }
    out.allocation = b.allocation
  }
  if (has('status')) {
    if (!['active', 'ended'].includes(b.status)) return { error: 'status must be active or ended' }
    out.status = b.status
  }
  if (has('includes_connectivity')) {
    if (typeof b.includes_connectivity !== 'boolean') return { error: 'includes_connectivity must be true or false' }
    out.includes_connectivity = b.includes_connectivity
  }
  if (has('vendor_id')) {
    if (b.vendor_id !== null && typeof b.vendor_id !== 'string') return { error: 'vendor_id must be a string' }
    out.vendor_id = b.vendor_id
  }
  const dates = contractDatesError(out)
  if (dates) return { error: dates }
  return { value: out }
}

/**
 * Why a contract's dates do not fit together, or null (checked on the merged row at update too). An
 * escalation date after the end is not an error: ending a contract early simply leaves it
 * inapplicable, and escalationDates stops at the end.
 */
export function contractDatesError(c: Pick<ContractInput, 'start_date' | 'end_date' | 'first_escalation_date'>): string | null {
  if (c.start_date && c.end_date && c.end_date < c.start_date) return 'end_date must be on or after start_date'
  if (c.first_escalation_date && c.start_date && c.first_escalation_date <= c.start_date) return 'first_escalation_date must be after start_date'
  return null
}

/**
 * End a contract's accrual schedules at `endDate`: each active fleet schedule of the contract still
 * open (or ending later) ends then, and one that starts after it is deactivated, so the close stops
 * proposing accruals past the contract. ensureDatacenterSchedule reads the contract's own end_date,
 * so a later roll recreates nothing past it. Idempotent: schedules already aligned are left alone,
 * so it is safe (and cheap) to run on every PATCH and roll of an ended contract, which is what
 * repairs a termination whose schedule write failed. `dryRun` counts what would change.
 */
export async function endDatacenterSchedules(
  admin: SupabaseClient, t: Pick<ScheduleTarget, 'fundId' | 'vehicleId'>, contractId: string, endDate: string, opts: { dryRun?: boolean } = {},
): Promise<number> {
  const prefix = `fleet:datacenter:${contractId}:`
  const { data, error } = await (admin as any).from('accounting_schedules').select('id, source_ref, start_date, end_date')
    .eq('fund_id', t.fundId).eq('vehicle_id', t.vehicleId).eq('active', true).like('source_ref', `${prefix}%`).order('start_date').order('id')
  if (error) throw error
  let changed = 0
  for (const row of ((data as any[]) ?? []).filter(r => String(r.source_ref).startsWith(prefix))) {
    const patch = row.start_date > endDate ? { active: false } : (!row.end_date || row.end_date > endDate) ? { end_date: endDate } : null
    if (!patch) continue
    changed++
    if (opts.dryRun) continue
    const { error: upError } = await (admin as any).from('accounting_schedules').update({ ...patch, updated_at: new Date().toISOString() })
      .eq('fund_id', t.fundId).eq('vehicle_id', t.vehicleId).eq('id', row.id)
    if (upError) throw upError
  }
  return changed
}

/** The vehicle's accrual accounts for a datacenter schedule: Dr 5100 / Cr 2000. */
export const DATACENTER_CODES = { expense: '5100', offset: '2000' } as const

// ── Writing the schedules ──

interface ScheduleTarget {
  fundId: string
  vehicleId: string
  userId: string | null
  /** Debit (the expense) and credit (accrued 2000, or prepaid 1500) account ids. */
  accounts: { expense: string; offset: string }
}

/** The deterministic key of a fleet-created schedule (`accounting_schedules.source_ref`). */
export const fleetScheduleRef = {
  datacenter: (contractId: string, start: string) => `fleet:datacenter:${contractId}:${start}`,
  insurance: (key: string, start: string) => `fleet:insurance:${key}:${start}`,
}

interface StoredSchedule { id: string; start_date: string; end_date: string | null; amount: number | null }

/** A refusal from a schedule writer: another request mid-write, or a key reused for different terms. */
export type ScheduleRefusal = { error: string; inProgress?: true }

/** The schedule under `sourceRef`, with its debit line's amount (null while its lines are not committed). */
async function scheduleByRef(admin: SupabaseClient, t: ScheduleTarget, sourceRef: string): Promise<StoredSchedule | null> {
  const { data, error } = await (admin as any).from('accounting_schedules')
    .select('id, start_date, end_date, accounting_schedule_lines(amount, sort_order)')
    .eq('fund_id', t.fundId).eq('vehicle_id', t.vehicleId).eq('source_ref', sourceRef).order('id').limit(1)
  if (error) throw error
  const row = ((data as any[]) ?? [])[0]
  if (!row) return null
  const debit = (row.accounting_schedule_lines ?? []).find((l: any) => l.sort_order === 0)
  return { id: row.id, start_date: row.start_date, end_date: row.end_date, amount: debit ? Number(debit.amount) : null }
}

/**
 * Adopt a stored schedule only when it is complete and is the one asked for. A header whose lines
 * are not committed is another request mid-write (it may yet delete the header): in progress. A
 * key reused for a different amount (or, when `matchEnd`, a different end date) is refused rather
 * than silently answered with the old schedule.
 */
function adoptSchedule(stored: StoredSchedule, period: SchedulePeriod, sourceRef: string, matchEnd: boolean): StoredSchedule | ScheduleRefusal {
  if (stored.amount === null) {
    return { error: `Schedule ${stored.id} (${sourceRef}, from ${stored.start_date}) is still being written by another request. Try again shortly.`, inProgress: true }
  }
  if (Math.round(stored.amount * 100) !== Math.round(period.amount * 100) || (matchEnd && stored.end_date !== period.end)) {
    return { error: `${sourceRef} already exists as schedule ${stored.id} for ${stored.amount} a month to ${stored.end_date ?? 'open'}, not ${period.amount} to ${period.end ?? 'open'}.` }
  }
  return stored
}

/**
 * Insert one schedule and its two lines under `sourceRef`, or adopt the row already there
 * (adoptSchedule). The partial unique index accounting_schedules_fleet_once makes this exact under
 * concurrency: the second of two simultaneous inserts gets 23505 and adopts the first's row, never
 * a second required-for-close accrual. Returns the STORED end date, which the rollover ends from.
 * If the lines fail, the header is deleted rather than left active with nothing to post.
 */
async function insertSchedule(
  admin: SupabaseClient, t: ScheduleTarget, name: string, period: SchedulePeriod, sourceRef: string, matchEnd: boolean,
): Promise<StoredSchedule | ScheduleRefusal> {
  const existing = await scheduleByRef(admin, t, sourceRef)
  if (existing) return adoptSchedule(existing, period, sourceRef, matchEnd)

  const { data, error } = await (admin as any).from('accounting_schedules').insert({
    fund_id: t.fundId, vehicle_id: t.vehicleId, name, memo: name, source_type: 'partnership_expense', source_ref: sourceRef,
    start_date: period.start, end_date: period.end, day_of_month: MONTH_END_DAY, required_for_close: true,
    active: true, created_by: t.userId,
  }).select('id').single()
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      const winner = await scheduleByRef(admin, t, sourceRef)
      if (winner) return adoptSchedule(winner, period, sourceRef, matchEnd)
    }
    throw error
  }
  const { error: lineError } = await (admin as any).from('accounting_schedule_lines').insert([
    { schedule_id: data.id, account_id: t.accounts.expense, amount: period.amount, sort_order: 0 },
    { schedule_id: data.id, account_id: t.accounts.offset, amount: -period.amount, sort_order: 1 },
  ])
  if (lineError) {
    await (admin as any).from('accounting_schedules').delete().eq('fund_id', t.fundId).eq('vehicle_id', t.vehicleId).eq('id', data.id)
    throw lineError
  }
  return { id: data.id, start_date: period.start, end_date: period.end, amount: period.amount }
}

/**
 * Bring the contract's accrual schedules up to the escalation period containing `asOf`.
 *
 * Every period through `asOf` gets its own schedule (keyed by contract and start date), and each
 * schedule's STORED end date is brought to the day before the next period starts, so an intermediate
 * year is never skipped and a schedule left open by an earlier failed attempt is closed rather than
 * accruing alongside its successor. Periods starting before the linked schedule are taken as done,
 * a contract set up late creates its whole history once, and a re-run changes nothing. A schedule
 * another request is still writing makes the whole call in progress, with nothing linked.
 */
export async function ensureDatacenterSchedule(
  admin: SupabaseClient,
  contract: DatacenterContractRow,
  t: ScheduleTarget,
  asOf: string,
): Promise<{ scheduleId: string; created: number } | ScheduleRefusal> {
  if (contract.fund_id !== t.fundId || contract.vehicle_id !== t.vehicleId) throw new Error('This contract belongs to another entity')
  const periods = datacenterPeriods(contract, asOf)
  let todo = periods

  if (contract.schedule_id) {
    const { data: current, error } = await (admin as any).from('accounting_schedules')
      .select('id, start_date').eq('fund_id', t.fundId).eq('vehicle_id', t.vehicleId).eq('id', contract.schedule_id).maybeSingle()
    if (error) throw error
    if (current) todo = periods.filter(p => p.start >= current.start_date)
  }

  const name = `Datacenter \u2014 ${contract.facility}`
  let created = 0
  let previous: StoredSchedule | null = null
  for (const period of todo) {
    const ref = fleetScheduleRef.datacenter(contract.id, period.start)
    const before = await scheduleByRef(admin, t, ref)
    // The stored end of an earlier period is the rollover's to change, so only the amount must match.
    const row = before ? adoptSchedule(before, period, ref, false) : await insertSchedule(admin, t, name, period, ref, false)
    if ('error' in row) return row
    if (!before) created++
    if (previous) {
      const end = dayBefore(period.start)
      if (!previous.end_date || previous.end_date > end) {
        const { error } = await (admin as any).from('accounting_schedules')
          .update({ end_date: end, updated_at: new Date().toISOString() }).eq('fund_id', t.fundId).eq('vehicle_id', t.vehicleId).eq('id', previous.id)
        if (error) throw error
      }
    }
    previous = row
  }

  if (previous && previous.id !== contract.schedule_id) {
    const { error } = await (admin as any).from('datacenter_contracts')
      .update({ schedule_id: previous.id, updated_at: new Date().toISOString() }).eq('fund_id', t.fundId).eq('vehicle_id', t.vehicleId).eq('id', contract.id)
    if (error) throw error
  }
  return { scheduleId: previous?.id ?? contract.schedule_id!, created }
}

/**
 * The prepaid premium's amortization schedules (Dr 5200 / Cr 1500); returns their ids in order.
 * `key` identifies the policy (e.g. its number), so a double submit adopts rather than duplicates,
 * and the same key with a different premium or period is refused.
 */
export async function createInsuranceSchedules(
  admin: SupabaseClient,
  t: ScheduleTarget,
  p: { key: string; name: string; premium: number; startDate: string; months: number },
): Promise<string[] | ScheduleRefusal> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(p.key ?? '')) return { error: 'key must be 1\u201364 letters, digits, hyphens or underscores' }
  const periods = insurancePeriods(p.premium, p.startDate, p.months)
  // A policy key names ONE policy: reusing it with a different start is refused, not a second policy.
  const prefix = `fleet:insurance:${p.key}:`
  const { data: used, error } = await (admin as any).from('accounting_schedules').select('id, source_ref, start_date')
    .eq('fund_id', t.fundId).eq('vehicle_id', t.vehicleId).like('source_ref', `${prefix}%`).order('start_date').order('id')
  if (error) throw error
  const starts = new Set(periods.map(x => x.start))
  const other = ((used as any[]) ?? []).find(r => String(r.source_ref).startsWith(prefix) && !starts.has(r.start_date))
  if (other) return { error: `Policy key ${p.key} is already used for a schedule starting ${other.start_date} (schedule ${other.id}). Use a new key for a new policy.` }
  const ids: string[] = []
  for (const period of periods) {
    const row = await insertSchedule(admin, t, p.name, period, fleetScheduleRef.insurance(p.key, period.start), true)
    if ('error' in row) return row
    ids.push(row.id)
  }
  return ids
}
