// ── GPU fleet (P3) ── A GPU SPV's fleet as a portfolio holding: one `companies` row per GPU SPV
// (holding_type 'gpu_fleet', portfolio_group = the vehicle), carrying the fleet KPIs as monthly
// metrics so they chart on a company page like any portfolio company's (metrics-publish.ts).

import type { SupabaseClient } from '@supabase/supabase-js'
import { createCompany } from '@/lib/companies/create'

export interface GpuMetricTemplate {
  slug: string
  name: string
  unit: string | null
  unit_position: 'prefix' | 'suffix'
  value_type: 'number' | 'currency' | 'percentage'
}

/** The fleet's monthly metrics. Per-type variants (`<slug>--<type code>`) are made on publish. */
export const GPU_METRIC_TEMPLATES: GpuMetricTemplate[] = [
  { slug: 'gpu-utilization', name: 'GPU utilization', unit: '%', unit_position: 'suffix', value_type: 'percentage' },
  { slug: 'gpu-realized-rate', name: 'Realized rate ($/GPU-hr)', unit: '$', unit_position: 'prefix', value_type: 'currency' },
  { slug: 'gpu-uptime', name: 'Uptime', unit: '%', unit_position: 'suffix', value_type: 'percentage' },
  { slug: 'gpu-revenue', name: 'Rental revenue', unit: '$', unit_position: 'prefix', value_type: 'currency' },
  { slug: 'gpu-fee', name: 'Marketplace fees', unit: '$', unit_position: 'prefix', value_type: 'currency' },
  { slug: 'gpu-net', name: 'Net revenue', unit: '$', unit_position: 'prefix', value_type: 'currency' },
  { slug: 'gpu-hours-rented', name: 'GPU-hours rented', unit: 'GPU-hrs', unit_position: 'suffix', value_type: 'number' },
  { slug: 'gpu-count', name: 'GPUs in service', unit: 'GPUs', unit_position: 'suffix', value_type: 'number' },
  { slug: 'gpu-downtime-hours', name: 'Downtime GPU-hours', unit: 'GPU-hrs', unit_position: 'suffix', value_type: 'number' },
]

/** The per-type variants publication creates when a server type first appears. */
export const PER_TYPE_SLUGS = ['gpu-utilization', 'gpu-realized-rate'] as const
export const perTypeSlug = (slug: string, typeCode: string) => `${slug}--${typeCode.toLowerCase()}`

export const fleetCompanyName = (vehicle: string) => `Fleet — ${vehicle}`

/** The fund's gpu-* default-metric templates (holding_type 'gpu_fleet'); existing ones are kept as they are. */
export async function ensureGpuTemplates(admin: SupabaseClient, fundId: string): Promise<void> {
  const { error } = await (admin as any).from('default_metrics').upsert(
    GPU_METRIC_TEMPLATES.map((t, i) => ({
      fund_id: fundId, name: t.name, slug: t.slug, unit: t.unit, unit_position: t.unit_position, value_type: t.value_type,
      reporting_cadence: 'monthly', display_order: i, currency: t.value_type === 'currency' ? 'USD' : null,
      is_active: true, holding_type: 'gpu_fleet',
    })),
    { onConflict: 'fund_id,slug', ignoreDuplicates: true },
  )
  if (error) throw new Error(`The GPU metric templates could not be saved: ${error.message}`)
}

/**
 * The GPU SPV's fleet company, created (and seeded with the gpu-* metrics) the first time. Found by
 * kind and by its `portfolio_group` naming the vehicle, which is also what links it to the entity
 * (company_vehicles is derived from portfolio_group). Idempotent; a fresh read failure throws.
 */
export async function ensureFleetCompany(admin: SupabaseClient, fundId: string, vehicleName: string, userId: string): Promise<string> {
  const find = async () => {
    // Active only: a fleet company retired by a merge (reconcileFleetCompaniesAfterMerge) still names
    // the surviving vehicle, and must not be the one that keeps publishing.
    const { data, error } = await (admin as any).from('companies').select('id')
      .eq('fund_id', fundId).eq('holding_type', 'gpu_fleet').eq('status', 'active')
      .contains('portfolio_group', [vehicleName]).order('created_at').limit(1)
    if (error) throw new Error(`The fleet company could not be read: ${error.message}`)
    return ((data as any[]) ?? [])[0]?.id as string | undefined
  }
  const existing = await find()
  if (existing) return existing
  await ensureGpuTemplates(admin, fundId)
  const created = await createCompany(admin, {
    fundId, userId, vehicleNames: null, holdingType: 'gpu_fleet',
    fields: { name: fleetCompanyName(vehicleName), portfolio_group: [vehicleName] },
  })
  if (!created.ok) throw new Error(`The fleet company could not be created: ${created.error}`)
  return created.company.id as string
}

/** The vehicle's active fleet company id, or null. Read before a merge rewrites portfolio_group. */
export async function activeFleetCompanyId(admin: SupabaseClient, fundId: string, vehicleName: string): Promise<string | null> {
  const { data, error } = await (admin as any).from('companies').select('id')
    .eq('fund_id', fundId).eq('holding_type', 'gpu_fleet').eq('status', 'active')
    .contains('portfolio_group', [vehicleName]).order('created_at').limit(1)
  if (error) throw error
  return ((data as any[]) ?? [])[0]?.id ?? null
}

/**
 * After two GPU SPVs merge, every company that named the source names the target, so both fleet
 * companies would claim it. Keep the target's own fleet company (`keepId`, read before the merge)
 * and retire the others: status 'exited', named as merged, so they stop publishing but keep their
 * history. A source fleet company alone (the target had none) becomes the target's.
 */
export async function reconcileFleetCompaniesAfterMerge(
  admin: SupabaseClient, fundId: string, intoName: string, keepId: string | null,
): Promise<{ kept: string | null; retired: string[] }> {
  const { data, error } = await (admin as any).from('companies').select('id, name, created_at')
    .eq('fund_id', fundId).eq('holding_type', 'gpu_fleet').eq('status', 'active')
    .contains('portfolio_group', [intoName]).order('created_at')
  if (error) throw error
  const rows = (data as any[]) ?? []
  if (!rows.length) return { kept: null, retired: [] }
  const kept = keepId && rows.some(r => r.id === keepId) ? keepId : rows[0].id
  const retired: string[] = []
  for (const r of rows) {
    if (r.id === kept) continue
    const { error: retireError } = await (admin as any).from('companies')
      .update({ status: 'exited', name: `${r.name} (merged into ${intoName})` }).eq('fund_id', fundId).eq('id', r.id)
    if (retireError) throw retireError
    retired.push(r.id)
  }
  if (!keepId) {
    const { error: renameError } = await (admin as any).from('companies').update({ name: fleetCompanyName(intoName) }).eq('fund_id', fundId).eq('id', kept)
    if (renameError) throw renameError
  }
  return { kept, retired }
}
