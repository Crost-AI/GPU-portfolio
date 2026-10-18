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

async function insertSchedule(admin: SupabaseClient, t: ScheduleTarget, name: string, period: SchedulePeriod): Promise<string> {
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
  if (lineError) throw lineError
  return data.id
}

/**
 * Make the contract's accrual schedule the one for the escalation period containing `asOf`.
 *
 * Idempotent: when the linked schedule already starts on that period's start, nothing changes. On
 * an escalation date it ends the current schedule the day before and creates the next at the
 * escalated fee, starting ON the escalation date, then links it from the contract.
 */
export async function ensureDatacenterSchedule(
  admin: SupabaseClient,
  contract: DatacenterContractRow,
  t: ScheduleTarget,
  asOf: string,
): Promise<{ scheduleId: string; created: boolean }> {
  const periods = datacenterPeriods(contract, asOf)
  const period = periods[periods.length - 1]

  if (contract.schedule_id) {
    const { data: current, error } = await (admin as any).from('accounting_schedules')
      .select('id, start_date, end_date').eq('fund_id', contract.fund_id).eq('id', contract.schedule_id).maybeSingle()
    if (error) throw error
    if (current?.start_date === period.start) return { scheduleId: current.id, created: false }
    if (current) {
      const end = dayBefore(period.start)
      if (!current.end_date || current.end_date > end) {
        const { error: endError } = await (admin as any).from('accounting_schedules')
          .update({ end_date: end, updated_at: new Date().toISOString() }).eq('fund_id', contract.fund_id).eq('id', current.id)
        if (endError) throw endError
      }
    }
  }

  const scheduleId = await insertSchedule(admin, t, `Datacenter — ${contract.facility}`, period)
  const { error } = await (admin as any).from('datacenter_contracts')
    .update({ schedule_id: scheduleId, updated_at: new Date().toISOString() }).eq('fund_id', contract.fund_id).eq('id', contract.id)
  if (error) throw error
  return { scheduleId, created: true }
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
