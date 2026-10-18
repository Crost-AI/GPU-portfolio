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

/**
 * Insert one schedule and its two lines, or return the one already there for this vehicle, name and
 * start date, so a double submit or a retry never creates a second required-for-close accrual. If
 * the lines fail, the header is deleted rather than left active with nothing to post.
 */
async function insertSchedule(admin: SupabaseClient, t: ScheduleTarget, name: string, period: SchedulePeriod): Promise<string> {
  const { data: existing, error: findError } = await (admin as any).from('accounting_schedules').select('id')
    .eq('fund_id', t.fundId).eq('vehicle_id', t.vehicleId).eq('name', name).eq('start_date', period.start).eq('active', true)
    .order('id').limit(1)
  if (findError) throw findError
  if (((existing as any[]) ?? []).length) return (existing as any[])[0].id

  const { data, error } = await (admin as any).from('accounting_schedules').insert({
    fund_id: t.fundId, vehicle_id: t.vehicleId, name, memo: name, source_type: 'partnership_expense',
    start_date: period.start, end_date: period.end, day_of_month: MONTH_END_DAY, required_for_close: true,
    active: true, created_by: t.userId,
  }).select('id').single()
  if (error) throw error
  const { error: lineError } = await (admin as any).from('accounting_schedule_lines').insert([
    { schedule_id: data.id, account_id: t.accounts.expense, amount: period.amount, sort_order: 0 },
    { schedule_id: data.id, account_id: t.accounts.offset, amount: -period.amount, sort_order: 1 },
  ])
  if (lineError) {
    await (admin as any).from('accounting_schedules').delete().eq('fund_id', t.fundId).eq('vehicle_id', t.vehicleId).eq('id', data.id)
    throw lineError
  }
  return data.id
}

/**
 * Bring the contract's accrual schedules up to the escalation period containing `asOf`.
 *
 * Every period through `asOf` gets its own schedule, each ending the day before the NEXT escalation
 * (an intermediate year is never skipped or absorbed by its predecessor), and the contract links
 * the latest. Periods starting on or before the linked schedule's start are taken as already
 * there, so a contract set up late creates its whole history once, and a re-run creates nothing.
 */
export async function ensureDatacenterSchedule(
  admin: SupabaseClient,
  contract: DatacenterContractRow,
  t: ScheduleTarget,
  asOf: string,
): Promise<{ scheduleId: string; created: number }> {
  if (contract.fund_id !== t.fundId || contract.vehicle_id !== t.vehicleId) throw new Error('This contract belongs to another entity')
  const periods = datacenterPeriods(contract, asOf)
  let previous: { id: string; end_date: string | null } | null = null
  let missing = periods

  if (contract.schedule_id) {
    const { data: current, error } = await (admin as any).from('accounting_schedules')
      .select('id, start_date, end_date').eq('fund_id', t.fundId).eq('vehicle_id', t.vehicleId).eq('id', contract.schedule_id).maybeSingle()
    if (error) throw error
    if (current) {
      previous = current
      missing = periods.filter(p => p.start > current.start_date)
    }
  }
  if (!missing.length) return { scheduleId: previous!.id, created: 0 }

  for (const period of missing) {
    if (previous) {
      const end = dayBefore(period.start)
      if (!previous.end_date || previous.end_date > end) {
        const { error } = await (admin as any).from('accounting_schedules')
          .update({ end_date: end, updated_at: new Date().toISOString() }).eq('fund_id', t.fundId).eq('vehicle_id', t.vehicleId).eq('id', previous.id)
        if (error) throw error
      }
    }
    previous = { id: await insertSchedule(admin, t, `Datacenter \u2014 ${contract.facility}`, period), end_date: period.end }
  }

  const { error } = await (admin as any).from('datacenter_contracts')
    .update({ schedule_id: previous!.id, updated_at: new Date().toISOString() }).eq('fund_id', t.fundId).eq('vehicle_id', t.vehicleId).eq('id', contract.id)
  if (error) throw error
  return { scheduleId: previous!.id, created: missing.length }
}

/** The prepaid premium's amortization schedules (Dr 5200 / Cr 1500); returns their ids in order. */
export async function createInsuranceSchedules(
  admin: SupabaseClient,
  t: ScheduleTarget,
  p: { name: string; premium: number; startDate: string; months: number },
): Promise<string[]> {
  const ids: string[] = []
  for (const period of insurancePeriods(p.premium, p.startDate, p.months)) ids.push(await insertSchedule(admin, t, p.name, period))
  return ids
}
