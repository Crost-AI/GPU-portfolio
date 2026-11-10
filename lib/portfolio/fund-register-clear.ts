// Clearing the fund-register rows left on a holding that is no longer a fund holding, for the
// `clear_fund_register` agent tool.
//
// A holding recorded as a fund and later changed to a company or digital asset keeps its terms,
// capital notices and NAV statements, and the investment transactions those notices and statements
// booked stay owned by them (lib/portfolio/transaction-edit.ts fundRegisterOwner): the company page
// cannot edit or delete them. Removing the register rows releases the transactions to the company
// page. The transactions and their journal entries are NOT touched, so the books do not move.
//
// A fund holding is refused: there the register IS the record, and its rows are changed on the
// holding page or the whole holding deleted (lib/portfolio/fund-holding-delete.ts).

import type { SupabaseClient } from '@supabase/supabase-js'
import { logActivity } from '@/lib/activity'
import { dbFail, done, fail, type Outcome } from '@/lib/service-outcome'

export const REGISTER_TABLES = ['fund_capital_events', 'fund_nav_statements', 'fund_holding_terms'] as const

export interface RegisterRows {
  capitalEvents: number
  navStatements: number
  terms: number
  /** Investment transactions the notices and statements booked; kept, and released to the company page. */
  transactionsReleased: string[]
}

/** What the register holds for this company on this entity. */
export async function readRegisterRows(
  admin: SupabaseClient, fundId: string, companyId: string, vehicleId: string,
): Promise<Outcome<RegisterRows>> {
  const where = (table: string, cols: string) => (admin as any).from(table).select(cols)
    .eq('fund_id', fundId).eq('company_id', companyId).eq('vehicle_id', vehicleId)
  const [events, navs, terms] = await Promise.all([
    where('fund_capital_events', 'id, investment_transaction_id'),
    where('fund_nav_statements', 'id, investment_transaction_id'),
    where('fund_holding_terms', 'id'),
  ])
  const failed = events.error ?? navs.error ?? terms.error
  if (failed) return dbFail(failed, 'fund-register-clear-read')
  const linked = [...((events.data as any[]) ?? []), ...((navs.data as any[]) ?? [])]
    .map(r => r.investment_transaction_id).filter(Boolean) as string[]
  return done({
    capitalEvents: ((events.data as any[]) ?? []).length,
    navStatements: ((navs.data as any[]) ?? []).length,
    terms: ((terms.data as any[]) ?? []).length,
    transactionsReleased: Array.from(new Set(linked)),
  })
}

export async function clearFundRegister(
  admin: SupabaseClient,
  who: { fundId: string; userId: string },
  companyId: string,
  vehicleId: string,
): Promise<Outcome<{ ok: true; id: string; name: string } & RegisterRows>> {
  const { data: company, error: companyError } = await (admin as any)
    .from('companies').select('id, name, holding_type').eq('id', companyId).eq('fund_id', who.fundId).maybeSingle()
  if (companyError) return dbFail(companyError, 'fund-register-clear')
  if (!company) return fail(404, 'Company not found')
  if (company.holding_type === 'fund') {
    return fail(409, `${company.name} is a fund holding, so its register is its record. Change its notices and NAV statements `
      + `on the holding page, or delete the holding with delete_fund_holding.`)
  }

  const rows = await readRegisterRows(admin, who.fundId, companyId, vehicleId)
  if (!rows.ok) return rows

  // Notices and statements first, so a failure part-way never leaves notices with no terms row
  // above them; each delete is scoped to the fund, the company and the entity.
  for (const table of REGISTER_TABLES) {
    const { error } = await (admin as any).from(table).delete()
      .eq('fund_id', who.fundId).eq('company_id', companyId).eq('vehicle_id', vehicleId)
    if (error) return dbFail(error, `fund-register-clear-${table}`)
  }

  logActivity(admin, who.fundId, who.userId, 'company.register_cleared', {
    companyId, companyName: company.name, vehicleId,
    capitalEvents: rows.value.capitalEvents, navStatements: rows.value.navStatements, terms: rows.value.terms,
  })

  return done({ ok: true, id: company.id, name: company.name, ...rows.value })
}
