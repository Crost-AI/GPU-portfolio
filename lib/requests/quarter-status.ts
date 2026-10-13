// One quarter's portfolio data request: whether it went out, when responses are due, and which
// companies have answered. The response rule is resolveResponseStatus, the same one the response
// tracker (app/api/requests/responses) and the follow-up reminder use, so the three agree.

import type { SupabaseClient } from '@supabase/supabase-js'
import { lastEndedQuarter, metricQuarter, resolveResponseStatus, responseKey, type ResponseStatus } from './response-status'

export interface QuarterRequestStatus {
  year: number
  quarter: number
  label: string
  /** The request(s) sent for the quarter, newest first. Empty when none has gone out. */
  requests: { sentAt: string | null; dueDate: string | null; recipients: number }[]
  companies: { id: string; name: string; status: ResponseStatus }[]
  counts: Record<ResponseStatus, number>
}

const PAGE = 1000

/**
 * `companyIds` is the caller's visible companies (null = every one). `period` defaults to the last
 * quarter that has ended, the one a request asks about.
 */
export async function loadQuarterRequestStatus(
  admin: SupabaseClient,
  fundId: string,
  companyIds: string[] | null,
  period: { year: number; quarter: number } | null,
  today: string,
): Promise<QuarterRequestStatus> {
  const { year, quarter } = period ?? lastEndedQuarter(today)
  const db = admin as any
  const counts: Record<ResponseStatus, number> = { yes: 0, no: 0, na: 0, waived: 0 }

  let cq = db.from('companies').select('id, name').eq('fund_id', fundId).eq('holding_type', 'company').eq('status', 'active')
  if (companyIds !== null) cq = cq.in('id', companyIds)
  const [{ data: companies, error: cErr }, { data: requests, error: rErr }] = await Promise.all([
    companyIds !== null && companyIds.length === 0 ? { data: [], error: null } : cq.order('name'),
    db.from('email_requests').select('sent_at, due_date, recipients, status')
      .eq('fund_id', fundId).eq('year', year).eq('quarter', quarter).eq('status', 'sent')
      .order('sent_at', { ascending: false }),
  ])
  if (cErr) throw new Error(`companies read failed: ${cErr.message}`)
  if (rErr) throw new Error(`email_requests read failed: ${rErr.message}`)

  const list = ((companies as any[]) ?? []) as { id: string; name: string }[]
  const sent = ((requests as any[]) ?? []).map(r => ({
    sentAt: r.sent_at ?? null,
    dueDate: r.due_date ?? null,
    recipients: Array.isArray(r.recipients) ? r.recipients.length : 0,
  }))
  if (list.length === 0) return { year, quarter, label: `Q${quarter} ${year}`, requests: sent, companies: [], counts }

  const ids = list.map(c => c.id)
  const hasData = new Set<string>()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from('metric_values').select('company_id, period_year, period_quarter, period_month')
      .eq('fund_id', fundId).eq('period_year', year).in('company_id', ids)
      .order('id').range(from, from + PAGE - 1)
    if (error) throw new Error(`metric_values read failed: ${error.message}`)
    const rows = (data as any[]) ?? []
    for (const mv of rows) if (metricQuarter(mv) === quarter) hasData.add(mv.company_id)
    if (rows.length < PAGE) break
  }
  const { data: overrides, error: oErr } = await db.from('ask_response_overrides').select('company_id, status')
    .eq('fund_id', fundId).eq('year', year).eq('quarter', quarter).in('company_id', ids)
  if (oErr) throw new Error(`ask_response_overrides read failed: ${oErr.message}`)
  const override = new Map(((overrides as any[]) ?? []).map(o => [responseKey(o.company_id, year, quarter), o.status as string]))

  const rows = list.map(c => {
    const status = resolveResponseStatus(hasData.has(c.id), override.get(responseKey(c.id, year, quarter)))
    counts[status] += 1
    return { id: c.id, name: c.name, status }
  })
  return { year, quarter, label: `Q${quarter} ${year}`, requests: sent, companies: rows, counts }
}
