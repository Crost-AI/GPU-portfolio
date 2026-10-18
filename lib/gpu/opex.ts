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
    end: i + 1 < starts.length ? dayBefore(starts[i + 1]) : c.end_date,
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

interface StoredSchedule { id: string; end_date: string | null }

async function scheduleByRef(admin: SupabaseClient, t: ScheduleTarget, sourceRef: string): Promise<StoredSchedule | null> {
  const { data, error } = await (admin as any).from('accounting_schedules').select('id, end_date')
    .eq('fund_id', t.fundId).eq('vehicle_id', t.vehicleId).eq('source_ref', sourceRef).order('id').limit(1)
  if (error) throw error
  return ((data as any[]) ?? [])[0] ?? null
}

/**
 * Insert one schedule and its two lines under `sourceRef`, or return the row already there. The
 * partial unique index accounting_schedules_fleet_once makes this exact under concurrency: the
 * second of two simultaneous inserts gets 23505 and adopts the first's row, never a second
 * required-for-close accrual. Returns the STORED end date, which the rollover ends from. If the
 * lines fail, the header is deleted rather than left active with nothing to post.
 */
async function insertSchedule(
  admin: SupabaseClient, t: ScheduleTarget, name: string, period: SchedulePeriod, sourceRef: string,
): Promise<StoredSchedule> {
  const existing = await scheduleByRef(admin, t, sourceRef)
  if (existing) return existing

  const { data, error } = await (admin as any).from('accounting_schedules').insert({
    fund_id: t.fundId, vehicle_id: t.vehicleId, name, memo: name, source_type: 'partnership_expense', source_ref: sourceRef,
    start_date: period.start, end_date: period.end, day_of_month: MONTH_END_DAY, required_for_close: true,
    active: true, created_by: t.userId,
  }).select('id').single()
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      const winner = await scheduleByRef(admin, t, sourceRef)
      if (winner) return winner
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
  return { id: data.id, end_date: period.end }
}

/**
 * Bring the contract's accrual schedules up to the escalation period containing `asOf`.
 *
 * Every period through `asOf` gets its own schedule (keyed by contract and start date), and each
 * schedule's STORED end date is brought to the day before the next period starts, so an intermediate
 * year is never skipped and a schedule left open by an earlier failed attempt is closed rather than
 * accruing alongside its successor. Periods starting before the linked schedule are taken as done,
 * a contract set up late creates its whole history once, and a re-run changes nothing.
 */
export async function ensureDatacenterSchedule(
  admin: SupabaseClient,
  contract: DatacenterContractRow,
  t: ScheduleTarget,
  asOf: string,
): Promise<{ scheduleId: string; created: number }> {
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
    const before = await scheduleByRef(admin, t, fleetScheduleRef.datacenter(contract.id, period.start))
    const row = before ?? await insertSchedule(admin, t, name, period, fleetScheduleRef.datacenter(contract.id, period.start))
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
 * `key` identifies the policy (e.g. its number), so a double submit adopts rather than duplicates.
 */
export async function createInsuranceSchedules(
  admin: SupabaseClient,
  t: ScheduleTarget,
  p: { key: string; name: string; premium: number; startDate: string; months: number },
): Promise<string[]> {
  const ids: string[] = []
  for (const period of insurancePeriods(p.premium, p.startDate, p.months)) {
    ids.push((await insertSchedule(admin, t, p.name, period, fleetScheduleRef.insurance(p.key, period.start))).id)
  }
  return ids
}
