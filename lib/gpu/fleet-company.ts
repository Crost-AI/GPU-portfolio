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
    const { data, error } = await (admin as any).from('companies').select('id')
      .eq('fund_id', fundId).eq('holding_type', 'gpu_fleet').contains('portfolio_group', [vehicleName]).order('created_at').limit(1)
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
