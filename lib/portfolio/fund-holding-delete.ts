// Deleting a fund holding, shared by DELETE /api/portfolio/fund-holdings/[id] and the
// `delete_fund_holding` agent tool, so both refuse the same things in the same words.
//
// The holding goes with its terms, register and NAV statements (they cascade), and its own chart
// accounts are removed after it. REFUSED once anything has posted: a register row carrying an
// investment_transaction_id is represented in the ledger, and deleting the holding behind the
// ledger's back leaves postings referencing a holding that no longer exists.

import type { SupabaseClient } from '@supabase/supabase-js'
import { LEDGER_BOOKS } from '@/lib/accounting/books'
import { companyDeleteDenial } from '@/lib/access/company-delete'
import type { EntityScope } from '@/lib/access/entity-scope'
import { logActivity } from '@/lib/activity'
import { dbFail, done, fail, type Outcome } from '@/lib/service-outcome'

export interface FundHoldingDeleted {
  ok: true
  id: string
  name: string
  accountsRemoved: number
  /** Set when the holding went but some of its chart accounts could not be removed. */
  warning?: string
}

export async function deleteFundHolding(
  admin: SupabaseClient,
  who: { fundId: string; userId: string },
  companyId: string,
  /** The caller's entity scope, read only once the holding is known to exist. */
  loadScope: () => Promise<Pick<EntityScope, 'access' | 'vehicleNames'>>,
): Promise<Outcome<FundHoldingDeleted>> {
  const fundId = who.fundId

  // A FUND holding only: a company or a digital asset has its own delete and checks (lib/companies/delete.ts).
  const { data: holding, error: holdingError } = await (admin as any)
    .from('companies').select('id, name').eq('id', companyId).eq('fund_id', fundId).eq('holding_type', 'fund').maybeSingle()
  if (holdingError) return dbFail(holdingError, 'fund-holdings-id-delete')
  if (!holding) return fail(404, 'Fund holding not found')

  // Deleting removes the holding for every entity that commits to it, so a member may delete only
  // a holding wholly theirs.
  const deleteDenied = await companyDeleteDenial(admin, await loadScope(), companyId)
  if (deleteDenied) return fail(403, deleteDenied.replace('this company', 'this fund'))

  // Every check below REFUSES on a failed read: a read that failed is not a holding with nothing on it.
  const { count, error: eventsError } = await (admin as any)
    .from('fund_capital_events')
    .select('id', { count: 'exact', head: true })
    .eq('fund_id', fundId)
    .eq('company_id', companyId)
    .not('investment_transaction_id', 'is', null)
  if (eventsError) return dbFail(eventsError, 'fund-holdings-id-delete')
  if ((count ?? 0) > 0) {
    return fail(409, `This holding has ${count} confirmed event(s) posted to the ledger. `
      + `Reverse those entries before deleting the holding.`)
  }

  const { count: navCount, error: navError } = await (admin as any)
    .from('fund_nav_statements')
    .select('id', { count: 'exact', head: true })
    .eq('fund_id', fundId)
    .eq('company_id', companyId)
    .not('investment_transaction_id', 'is', null)
  if (navError) return dbFail(navError, 'fund-holdings-id-delete')
  if ((navCount ?? 0) > 0) {
    return fail(409, `This holding has ${navCount} NAV statement(s) with a mark on the ledger. `
      + `Delete its NAV statements first — deleting one takes its mark off the ledger.`)
  }

  // Any investment transaction left — one recorded directly, or adopted from a journal entry — is
  // the ledger's too, and cascading it away would skip the retraction its own delete does (as the
  // companies route refuses).
  const { count: txnCount, error: txnError } = await (admin as any)
    .from('investment_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('fund_id', fundId)
    .eq('company_id', companyId)
  if (txnError) return dbFail(txnError, 'fund-holdings-id-delete')
  if ((txnCount ?? 0) > 0) {
    return fail(409, `This holding has ${txnCount} investment transaction(s). `
      + `Delete them first so their accounting entries are retracted.`)
  }

  // The holding's own accounts (1100-<id>, 1200-<id>, …). chart_of_accounts.company_id is
  // ON DELETE SET NULL, so deleting the company ORPHANS these rather than removing them —
  // they linger in the chart with a null company_id, named after a holding that no longer
  // exists. Remove them here instead, but only once we know they carry nothing.
  const { data: acctRows, error: acctError } = await (admin as any)
    .from('chart_of_accounts')
    .select('id, code')
    .eq('fund_id', fundId)
    .eq('company_id', companyId)
  if (acctError) return dbFail(acctError, 'fund-holdings-id-delete')
  const acctIds = ((acctRows as any[]) ?? []).map(a => a.id)

  if (acctIds.length > 0) {
    // A posting against one of these accounts — in ANY book, tax adjustments included — means this
    // holding is in the ledger by some path the checks above do not cover. Deleting then would
    // strand postings pointing at accounts for a deleted holding.
    const { count: postingCount, error: postingError } = await (admin as any)
      .from('journal_postings')
      .select('id', { count: 'exact', head: true })
      .in('book', LEDGER_BOOKS)
      .eq('fund_id', fundId)
      .in('account_id', acctIds)
    if (postingError) return dbFail(postingError, 'fund-holdings-id-delete')
    if ((postingCount ?? 0) > 0) {
      return fail(409, `This holding's accounts carry ${postingCount} ledger posting(s). `
        + `Reverse the entries behind them before deleting the holding.`)
    }
  }

  const { error } = await (admin as any).from('companies').delete().eq('id', companyId).eq('fund_id', fundId)
  if (error) return dbFail(error, 'fund-holdings-id-delete')

  logActivity(admin, fundId, who.userId, 'company.delete', { companyId, companyName: holding.name })

  // After the company is gone: its accounts now have a null company_id, so delete by id.
  if (acctIds.length > 0) {
    const { error: acctErr } = await (admin as any)
      .from('chart_of_accounts').delete().eq('fund_id', fundId).in('id', acctIds)
    // The holding is already gone; a failure here leaves tidy-up, not corruption.
    if (acctErr) {
      return done({
        ok: true, id: companyId, name: holding.name, accountsRemoved: 0,
        warning: `The holding was deleted, but ${acctIds.length} of its chart accounts could not be removed: ${acctErr.message}`,
      })
    }
  }

  return done({ ok: true, id: companyId, name: holding.name, accountsRemoved: acctIds.length })
}
