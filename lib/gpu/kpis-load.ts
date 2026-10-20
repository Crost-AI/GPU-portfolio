// Read the register and the operations entries for computeKpis (kpis.ts). The vehicle is already
// resolved and checked to be a GPU SPV by the caller.

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/accounting/load'
import { computeKpis, ltm, monthBounds, trailingMonths, KPI_STATUSES, type Kpi, type KpiAsset, type KpiEarning, type MonthKpis } from './kpis'

export type FleetKpis = MonthKpis & { ltm: Kpi }

/**
 * `month`'s KPIs plus the trailing twelve months ending with it. `postedOnly` leaves staged rows
 * out — what a published metric uses, so a number on the fleet company is one the books hold.
 */
export async function loadFleetKpis(
  admin: SupabaseClient, fundId: string, vehicleId: string, month: string, opts: { postedOnly?: boolean } = {},
): Promise<FleetKpis> {
  const months = trailingMonths(month)
  const from = monthBounds(months[0]).start
  const to = monthBounds(month).end
  const [assets, types, earnings] = await Promise.all([
    fetchAllRows<any>((f, t) => (admin as any).from('gpu_assets').select('id, name, gpu_count, in_service_date, disposed_on, asset_type_id')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).range(f, t)),
    fetchAllRows<any>((f, t) => (admin as any).from('gpu_asset_types').select('id, code').eq('fund_id', fundId).range(f, t)),
    fetchAllRows<KpiEarning>((f, t) => (admin as any).from('gpu_earnings')
      .select('id, supersedes_id, asset_id, period_end, status, gpu_hours_rented, gross, marketplace_fee, net, downtime_hours')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).in('status', opts.postedOnly ? ['posted'] : KPI_STATUSES)
      .gte('period_end', from).lte('period_end', to).range(f, t)),
  ])
  const codeOf = new Map(types.map(t => [t.id, t.code as string]))
  const kpiAssets: KpiAsset[] = assets.map(a => ({
    id: a.id, name: a.name, gpu_count: Number(a.gpu_count), in_service_date: a.in_service_date, disposed_on: a.disposed_on,
    type_code: a.asset_type_id ? codeOf.get(a.asset_type_id) ?? null : null,
  }))
  const monthly = months.map(m => computeKpis({ assets: kpiAssets, earnings, month: m }))
  const current = monthly[monthly.length - 1]
  return { ...current, ltm: ltm(monthly.map(m => m.fleet)) }
}
