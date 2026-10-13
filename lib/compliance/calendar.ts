// A year of compliance deadlines for one fund, with where each stands: filed, open, or overdue.
// The same schedule (schedule.ts), the same applicability (the questionnaire, then the fund's own
// setting) and the same filed record (compliance_deadlines) as the compliance page and the
// ops-reminders digest, read through one loader so the three cannot disagree on what is owed.

import type { SupabaseClient } from '@supabase/supabase-js'
import { evaluateAll } from './applicability'
import { groupKey, occurrencesForYear } from './schedule'
import { resolveStatus } from './status'
import { loadCloseDates } from './closes'
import type { ComplianceData } from '@/lib/reminders/sources/compliance'

type QueryResult = { data: unknown; error: { message: string } | null }

function rowsOf<T>(table: string, res: QueryResult, prefix: string): T {
  if (res.error) throw new Error(`${prefix}${table} load failed: ${res.error.message}`)
  return (res.data ?? []) as T
}

const PAGE = 1000

/**
 * Every read a compliance schedule needs, for filings in `fromYear`..`toYear`. Closes are read a
 * year either side, since an event-driven filing hangs off a close.
 */
export async function loadComplianceData(
  admin: SupabaseClient,
  fundId: string,
  fromYear: number,
  toYear: number,
  errorPrefix = '',
): Promise<ComplianceData> {
  const db = admin as any
  const [itemsRes, profileRes, settingsRes, vehiclesRes, closeDates] = await Promise.all([
    db.from('compliance_items')
      .select('id, name, short_name, frequency, scope, deadline_month, deadline_day, rolling_days')
      .order('sort_order'),
    db.from('fund_compliance_profile').select('*').eq('fund_id', fundId).maybeSingle(),
    db.from('compliance_fund_settings').select('compliance_item_id, portfolio_group, applies, dismissed, notes').eq('fund_id', fundId),
    db.from('fund_vehicles').select('name').eq('fund_id', fundId),
    loadCloseDates(admin, fundId, `${fromYear - 1}-01-01`, `${toYear + 1}-12-31`, { errorPrefix }),
  ])
  const closed: ComplianceData['closed'] = []
  for (let from = 0; ; from += PAGE) {
    const res = await db.from('compliance_deadlines').select('compliance_item_id, portfolio_group, quarter, year, status')
      .eq('fund_id', fundId).in('status', ['filed', 'not_applicable']).gte('year', fromYear).lte('year', toYear)
      .order('id').range(from, from + PAGE - 1)
    const rows = rowsOf<ComplianceData['closed']>('compliance_deadlines', res, errorPrefix)
    closed.push(...rows)
    if (rows.length < PAGE) break
  }
  if (profileRes.error) throw new Error(`${errorPrefix}fund_compliance_profile load failed: ${profileRes.error.message}`)
  return {
    items: rowsOf('compliance_items', itemsRes, errorPrefix),
    profile: profileRes.data ?? null,
    settings: rowsOf('compliance_fund_settings', settingsRes, errorPrefix),
    closed,
    portfolioGroups: rowsOf<{ name: string }[]>('fund_vehicles', vehiclesRes, errorPrefix).map(v => v.name).sort(),
    closeDates,
  }
}

export type CalendarState = 'filed' | 'not_applicable' | 'overdue' | 'open'

export interface CalendarRow {
  itemId: string
  name: string
  /** The entity it is for; empty for a firm-level filing. */
  entity: string
  quarter: number | null
  dueDate: string
  /** applies, or needs_review / monitor when nobody has said yet whether it does. */
  applicability: 'applies' | 'needs_review' | 'monitor'
  state: CalendarState
  notes: string | null
}

/**
 * The year's filings, earliest due first. Items that do not apply (by the questionnaire or the
 * fund's setting) are left out; ones awaiting a decision stay in, marked, because "does this
 * apply to us" is itself a task. Pure.
 */
export function complianceCalendar(data: ComplianceData, year: number, today: string): CalendarRow[] {
  const applicability = data.profile ? evaluateAll(data.profile) : {}
  const settingByKey = new Map(data.settings.map(s => [`${s.compliance_item_id}|${s.portfolio_group ?? ''}`, s]))
  const closed = new Map(data.closed.map(c => [`${c.compliance_item_id}|${groupKey(c.portfolio_group ?? '', c.quarter ?? 0)}|${c.year}`, c.status ?? 'filed']))

  const out: CalendarRow[] = []
  for (const occ of occurrencesForYear(data.items, { year, portfolioGroups: data.portfolioGroups, closeDates: data.closeDates })) {
    const status = resolveStatus(settingByKey.get(`${occ.item.id}|${occ.groupKey}`), applicability[occ.item.id]?.result)
    if (status !== 'applies' && status !== 'needs_review' && status !== 'monitor') continue
    const done = closed.get(`${occ.item.id}|${occ.groupKey}|${occ.year}`)
    const notesGroup = occ.item.scope === 'vehicle' ? occ.portfolioGroup : ''
    out.push({
      itemId: occ.item.id,
      name: (occ.item as { name?: string }).name ?? occ.item.id,
      entity: occ.portfolioGroup,
      quarter: occ.quarter || null,
      dueDate: occ.dueDate,
      applicability: status,
      state: done === 'not_applicable' ? 'not_applicable' : done ? 'filed' : occ.dueDate < today ? 'overdue' : 'open',
      notes: settingByKey.get(`${occ.item.id}|${notesGroup}`)?.notes?.trim() || null,
    })
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name))
}
