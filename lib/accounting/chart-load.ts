import type { SupabaseClient } from '@supabase/supabase-js'
import type { Account, AccountType } from './types'
import { fetchAllRows } from './load'
import { vehicleIdByName, type VehicleIdMap } from './vehicle-id'

/**
 * A vehicle's chart of accounts, without its ledger. For the callers that only need the accounts —
 * the account picker, the agent's `list_accounts` — and would otherwise read every posting to get
 * them through `loadPostedLedger`. Same columns and the same `Account` shape as that loader, so the
 * two are interchangeable for the chart.
 *
 * Paged in `id` order: PostgREST caps a select at 1000 rows, and ranges over an unordered query
 * may skip or repeat rows between pages. A read error throws (fetchAllRows), never an empty chart.
 */
export async function loadChart(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  idMap?: VehicleIdMap,
): Promise<Account[]> {
  const vehicleId = await vehicleIdByName(admin, fundId, group, idMap)
  if (!vehicleId) return []
  const rows = await fetchAllRows<any>((f, t) => admin.from('chart_of_accounts' as any)
    .select('id, code, name, type, subtype, lp_entity_id, company_id')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).order('id').range(f, t))
  return rows.map(a => ({
    id: a.id,
    fundId,
    code: a.code,
    name: a.name,
    type: a.type as AccountType,
    subtype: a.subtype ?? null,
    lpEntityId: a.lp_entity_id ?? null,
    companyId: a.company_id ?? null,
  }))
}
