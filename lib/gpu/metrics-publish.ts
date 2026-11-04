// ── GPU fleet (P3) ── Publish a month's fleet KPIs as metric values on the GPU SPV's fleet company,
// so they chart on its company page like any portfolio company's reported metrics.

import type { SupabaseClient } from '@supabase/supabase-js'
import { fleetVehicleId } from './ops/import'
import { loadFleetKpis } from './kpis-load'
import type { Kpi } from './kpis'
import { UNTYPED } from './kpis'
import { ensureFleetCompany, GPU_METRIC_TEMPLATES, perTypeSlug, PER_TYPE_SLUGS, type GpuMetricTemplate } from './fleet-company'

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

/** Which KPI each fleet metric carries. */
const VALUE_OF: Record<string, (k: Kpi) => number | null> = {
  'gpu-utilization': k => k.utilizationPct,
  'gpu-realized-rate': k => k.realizedRate,
  'gpu-uptime': k => k.uptimePct,
  'gpu-revenue': k => k.grossRevenue,
  'gpu-fee': k => k.fee,
  'gpu-net': k => k.net,
  'gpu-hours-rented': k => k.rentedHours,
  'gpu-count': k => k.gpuCount,
  'gpu-downtime-hours': k => k.downtimeHours,
}

export interface PublishResult {
  companyId: string
  month: string
  /** slug → value written. */
  written: Record<string, number>
  /**
   * Slugs whose earlier computed value for the month was removed: the KPI has no value now (no
   * capacity, nothing rented), or its server type is gone. A manually entered value is never touched.
   */
  removed: string[]
}

/**
 * Write `month`'s KPIs onto the fleet company, from POSTED rows only (a published number is one the
 * books hold). Creates the fleet company and any missing metric (including a per-type variant the
 * first time a server type appears), then select-then-update-or-insert each value: the period's
 * unique index uses coalesce, so `onConflict` cannot target it (lib/pending-actions/metric-value.ts).
 * Re-publishing a month overwrites it, and removes a computed value the month no longer has (a rate
 * after a correction to zero hours, a server type with no servers left) — manual values stay.
 */
export async function publishFleetKpis(
  admin: SupabaseClient, fundId: string, group: string, month: string, userId: string,
): Promise<PublishResult | { error: string }> {
  if (!MONTH.test(month)) return { error: 'month must be YYYY-MM' }
  const vehicle = await fleetVehicleId(admin, fundId, group)
  if ('error' in vehicle) return vehicle
  const companyId = await ensureFleetCompany(admin, fundId, group, userId)
  const kpis = await loadFleetKpis(admin, fundId, vehicle.vehicleId, month, { postedOnly: true })

  const { data: runs, error: runError } = await (admin as any).from('gpu_import_runs').select('id')
    .eq('fund_id', fundId).eq('vehicle_id', vehicle.vehicleId).order('created_at', { ascending: false }).limit(1)
  if (runError) throw runError
  const runId = ((runs as any[]) ?? [])[0]?.id as string | undefined
  const notes = `Computed from GPU operations entries${runId ? ` (run ${runId})` : ''}`

  // What to write: the fleet-wide metrics, then each server type's variants.
  const wanted: { def: GpuMetricTemplate; value: number | null }[] = GPU_METRIC_TEMPLATES.map(def => ({ def, value: VALUE_OF[def.slug](kpis.fleet) }))
  for (const [code, k] of Object.entries(kpis.byType)) {
    if (code === UNTYPED) continue
    for (const slug of PER_TYPE_SLUGS) {
      const base = GPU_METRIC_TEMPLATES.find(t => t.slug === slug)!
      wanted.push({ def: { ...base, slug: perTypeSlug(slug, code), name: `${base.name} — ${code.toUpperCase()}` }, value: VALUE_OF[slug](k) })
    }
  }

  const { data: existing, error: metricsError } = await (admin as any).from('metrics').select('id, slug')
    .eq('fund_id', fundId).eq('company_id', companyId)
  if (metricsError) throw metricsError
  const idOf = new Map<string, string>(((existing as any[]) ?? []).map(m => [m.slug, m.id]))
  const missing = wanted.filter(w => !idOf.has(w.def.slug))
  if (missing.length) {
    const { data: created, error } = await (admin as any).from('metrics').upsert(missing.map((w, i) => ({
      fund_id: fundId, company_id: companyId, name: w.def.name, slug: w.def.slug, unit: w.def.unit, unit_position: w.def.unit_position,
      value_type: w.def.value_type, reporting_cadence: 'monthly', display_order: GPU_METRIC_TEMPLATES.length + i, is_active: true,
      currency: w.def.value_type === 'currency' ? 'USD' : null,
    })), { onConflict: 'company_id,slug', ignoreDuplicates: true }).select('id, slug')
    if (error) throw error
    for (const m of ((created as any[]) ?? [])) idOf.set(m.slug, m.id)
    // A concurrent publish created some first: read them back.
    if (missing.some(w => !idOf.has(w.def.slug))) {
      const { data: again, error: againError } = await (admin as any).from('metrics').select('id, slug').eq('fund_id', fundId).eq('company_id', companyId)
      if (againError) throw againError
      for (const m of ((again as any[]) ?? [])) idOf.set(m.slug, m.id)
    }
  }

  const year = Number(month.slice(0, 4))
  const monthNo = Number(month.slice(5, 7))
  const period = { period_label: month, period_year: year, period_quarter: Math.ceil(monthNo / 3), period_month: monthNo }
  const written: Record<string, number> = {}
  const removed: string[] = []
  /** Delete this month's COMPUTED value of a metric (never a manually entered one). */
  const clearComputed = async (slug: string, metricId: string) => {
    const { data, error } = await (admin as any).from('metric_values').delete()
      .eq('fund_id', fundId).eq('metric_id', metricId).eq('period_year', year).eq('period_quarter', period.period_quarter)
      .eq('period_month', monthNo).eq('is_manually_entered', false).select('id')
    if (error) throw error
    if (((data as any[]) ?? []).length) removed.push(slug)
  }
  const wantedSlugs = new Set(wanted.map(w => w.def.slug))
  for (const [slug, metricId] of idOf) {
    // A per-type metric whose type has no servers this month.
    if (!wantedSlugs.has(slug) && PER_TYPE_SLUGS.some(base => slug.startsWith(`${base}--`))) await clearComputed(slug, metricId)
  }
  for (const w of wanted) {
    if (w.value == null) {
      const metricId = idOf.get(w.def.slug)
      if (metricId) await clearComputed(w.def.slug, metricId)
      continue
    }
    const metricId = idOf.get(w.def.slug)
    if (!metricId) throw new Error(`Metric ${w.def.slug} could not be created`)
    const { data: found, error: findError } = await (admin as any).from('metric_values').select('id')
      .eq('metric_id', metricId).eq('period_year', year).eq('period_quarter', period.period_quarter).eq('period_month', monthNo).limit(1)
    if (findError) throw findError
    const values = { ...period, value_number: w.value, confidence: 'high', is_manually_entered: false, notes, updated_at: new Date().toISOString() }
    const prior = ((found as any[]) ?? [])[0]
    const { error } = prior
      ? await (admin as any).from('metric_values').update(values).eq('id', prior.id).eq('fund_id', fundId)
      : await (admin as any).from('metric_values').insert({ metric_id: metricId, company_id: companyId, fund_id: fundId, ...values })
    if (error) throw error
    written[w.def.slug] = w.value
  }
  return { companyId, month, written, removed }
}
