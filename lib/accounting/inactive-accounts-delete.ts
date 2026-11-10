// Deleting a holding's deactivated chart accounts on one entity, for the
// `delete_inactive_company_accounts` agent tool.
//
// Merging a duplicate holding into another moves its postings and deactivates its per-company
// accounts (1100-<id>, 1200-<id>, …) rather than deleting them, and a holding that leaves one entity
// but stays in another keeps its accounts on both. Deleting the company would remove all of them;
// this removes only the inactive ones on one entity, and only those nothing on the books points at.
// journal_postings and accounting_schedule_lines restrict the delete in the database too.

import type { SupabaseClient } from '@supabase/supabase-js'
import { LEDGER_BOOKS } from '@/lib/accounting/books'
import { dbFail, done, fail, type Outcome } from '@/lib/service-outcome'

export interface InactiveAccounts {
  /** The inactive accounts that would go, by code and name. */
  accounts: { id: string; code: string; name: string }[]
  /** Active accounts of the company on this entity, which stay. */
  activeKept: number
  postings: number
  scheduleLines: number
}

export async function readInactiveCompanyAccounts(
  admin: SupabaseClient, fundId: string, vehicleId: string, companyId: string,
): Promise<Outcome<InactiveAccounts>> {
  const { data: rows, error } = await (admin as any).from('chart_of_accounts')
    .select('id, code, name, is_active')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('company_id', companyId)
  if (error) return dbFail(error, 'inactive-accounts-read')
  const all = (rows as any[]) ?? []
  const accounts = all.filter(a => a.is_active === false).map(a => ({ id: a.id, code: a.code, name: a.name }))
  const ids = accounts.map(a => a.id)
  let postings = 0
  let scheduleLines = 0
  if (ids.length > 0) {
    // A posting in ANY book pins the account, tax adjustments included.
    const [p, s] = await Promise.all([
      (admin as any).from('journal_postings').select('id', { count: 'exact', head: true })
        .in('book', LEDGER_BOOKS).eq('fund_id', fundId).in('account_id', ids),
      (admin as any).from('accounting_schedule_lines').select('id', { count: 'exact', head: true }).in('account_id', ids),
    ])
    if (p.error) return dbFail(p.error, 'inactive-accounts-postings')
    if (s.error) return dbFail(s.error, 'inactive-accounts-schedules')
    postings = p.count ?? 0
    scheduleLines = s.count ?? 0
  }
  return done({ accounts, activeKept: all.length - accounts.length, postings, scheduleLines })
}

export async function deleteInactiveCompanyAccounts(
  admin: SupabaseClient, fundId: string, vehicleId: string, companyId: string,
): Promise<Outcome<{ ok: true; deleted: { code: string; name: string }[]; activeKept: number }>> {
  const read = await readInactiveCompanyAccounts(admin, fundId, vehicleId, companyId)
  if (!read.ok) return read
  const { accounts, activeKept, postings, scheduleLines } = read.value
  if (accounts.length === 0) return fail(404, 'This company has no inactive accounts on this entity.')
  if (postings > 0) {
    return fail(409, `These inactive accounts still carry ${postings} ledger posting(s). Move or reverse those entries first.`)
  }
  if (scheduleLines > 0) {
    return fail(409, `These inactive accounts are used by ${scheduleLines} schedule line(s). Remove them from the schedule first.`)
  }
  const { error } = await (admin as any).from('chart_of_accounts').delete()
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).in('id', accounts.map(a => a.id))
  if (error) return dbFail(error, 'inactive-accounts-delete')
  return done({ ok: true, deleted: accounts.map(({ code, name }) => ({ code, name })), activeKept })
}
