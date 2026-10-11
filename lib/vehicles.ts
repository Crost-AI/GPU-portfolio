import type { SupabaseClient } from '@supabase/supabase-js'

// Tables that still key a vehicle by the scalar portfolio_group string, so a
// rename/merge must rewrite the string in each. The accounting subsystem has
// been cut over to a vehicle_id FK (Phase 2) and is intentionally absent — its
// rows follow the vehicle by id, so a rename leaves them untouched. The LP,
// portfolio, and compliance tables remain string-keyed until they're cut too.
export const VEHICLE_SCALAR_TABLES = [
  'lp_investments', 'fund_cash_flows', 'fund_group_config', 'investment_transactions',
  'lp_letters', 'compliance_fund_settings', 'compliance_deadlines',
]

/**
 * Rewrite every vehicle-scoped row in the fund from one portfolio_group string to
 * another — the mechanism behind a vehicle rename (and the backfill's alias
 * merges). Not wrapped in a single transaction (supabase-js can't), but it's an
 * infrequent admin action over test-scale data; each table update is idempotent.
 */
export async function retagPortfolioGroup(
  admin: SupabaseClient,
  fundId: string,
  from: string,
  to: string,
): Promise<void> {
  if (from === to) return
  for (const t of VEHICLE_SCALAR_TABLES) {
    if (t === 'lp_investments' && (await retagLpInvestments(admin, fundId, from, to))) continue
    const { error } = await (admin as any).from(t).update({ portfolio_group: to }).eq('fund_id', fundId).eq('portfolio_group', from)
    if (error) console.error(`[vehicles] relabel ${t} ${from} → ${to}:`, error.message)
  }
  // companies.portfolio_group is a text[] — remap the matching element.
  const { data: cos } = await (admin as any).from('companies').select('id, portfolio_group').eq('fund_id', fundId)
  for (const c of ((cos as any[]) ?? [])) {
    const arr: string[] = Array.isArray(c.portfolio_group) ? c.portfolio_group : []
    if (arr.includes(from)) {
      const mapped = Array.from(new Set(arr.map(x => (x === from ? to : x))))
      await (admin as any).from('companies').update({ portfolio_group: mapped }).eq('id', c.id)
    }
  }
}

/**
 * LP positions relabel through lp_retag_portfolio_group (20261011200001), the one path the shared-
 * report lock lets change a shared row's vehicle. False when that function isn't in the database
 * yet, so the caller falls back to the plain update the lock still allows until then.
 */
async function retagLpInvestments(admin: SupabaseClient, fundId: string, from: string, to: string): Promise<boolean> {
  const { error } = await (admin as any).rpc('lp_retag_portfolio_group', { p_fund_id: fundId, p_from: from, p_to: to })
  if (!error) return true
  // PGRST202: no such function in the schema cache — the migration hasn't been applied.
  if (error.code === 'PGRST202' || /lp_retag_portfolio_group/.test(error.message ?? '')) return false
  console.error(`[vehicles] relabel lp_investments ${from} → ${to}:`, error.message)
  return true
}
