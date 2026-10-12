// Adding ONE chart account to a vehicle — shared by the chart page (app/api/accounting/chart,
// action 'add') and the agent's add_account tool. Distinct from the seeder, which is the
// bulk/idempotent path.

import type { SupabaseClient } from '@supabase/supabase-js'
import { vehicleIdByName } from './vehicle-id'

/** The `type` check constraint on chart_of_accounts. */
export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const

export async function addChartAccount(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  raw: { code?: unknown; name?: unknown; type?: unknown; subtype?: unknown },
): Promise<{ account: any } | { error: string; status: number }> {
  const code = String(raw?.code ?? '').trim()
  const name = String(raw?.name ?? '').trim()
  const type = String(raw?.type ?? '').trim()
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,19}$/.test(code)) {
    return { error: 'Code must be 1-20 characters: letters, digits, dot, dash or underscore.', status: 400 }
  }
  if (!name) return { error: 'A name is required', status: 400 }
  if (!ACCOUNT_TYPES.includes(type as any)) {
    return { error: `Type must be one of ${ACCOUNT_TYPES.join(', ')}`, status: 400 }
  }
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return { error: 'Unknown vehicle', status: 404 }
  const { data: clash } = await admin
    .from('chart_of_accounts' as any)
    .select('id').eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('code', code).maybeSingle()
  if (clash) return { error: `Account ${code} already exists on this vehicle.`, status: 400 }

  const { data, error } = await admin.from('chart_of_accounts' as any).insert({
    fund_id: fundId, portfolio_group: group, vehicle_id: vehicleId,
    code, name, type, subtype: raw?.subtype ? String(raw.subtype).trim() : null,
  }).select('*').single()
  if (error) {
    console.error('[accounting-chart-add]', error.message)
    return { error: 'An unexpected error occurred.', status: 500 }
  }
  return { account: data }
}
