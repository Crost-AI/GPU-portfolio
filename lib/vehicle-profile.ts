// An entity's reporting profile: its strategy, who administers its books, and when its LP reporting
// is due after a quarter-end. Facts about the entity, kept on fund_vehicles
// (20261013160000_vehicle_reporting_profile.sql), so a quarter-end question never has to be told
// them again. Read and written by /api/vehicles (the Edit vehicle modal) and the entity_profile /
// set_entity_profile agent tools; parsing is here so the two accept exactly the same input.

import type { SupabaseClient } from '@supabase/supabase-js'

export const STRATEGIES = ['venture', 'growth', 'buyout', 'credit', 'fund_of_funds', 'real_assets', 'other'] as const
export type Strategy = (typeof STRATEGIES)[number]

export const STRATEGY_LABELS: Record<Strategy, string> = {
  venture: 'Venture',
  growth: 'Growth equity',
  buyout: 'Buyout / private equity',
  credit: 'Private credit',
  fund_of_funds: 'Fund of funds',
  real_assets: 'Real assets',
  other: 'Other',
}

export interface VehicleProfile {
  strategy: Strategy | null
  /** An outside administrator's name, or "In-house". */
  administrator: string | null
  lpReportDaysQuarterly: number | null
  lpReportDaysAnnual: number | null
}

export const EMPTY_PROFILE: VehicleProfile = { strategy: null, administrator: null, lpReportDaysQuarterly: null, lpReportDaysAnnual: null }

/** The columns, as fund_vehicles names them. */
export const PROFILE_COLUMNS = 'strategy, administrator, lp_report_days_quarterly, lp_report_days_annual'

export function profileFromRow(row: Record<string, unknown> | null | undefined): VehicleProfile {
  if (!row) return EMPTY_PROFILE
  const n = (v: unknown) => (typeof v === 'number' ? v : null)
  return {
    strategy: STRATEGIES.includes(row.strategy as Strategy) ? (row.strategy as Strategy) : null,
    administrator: typeof row.administrator === 'string' && row.administrator.trim() ? row.administrator : null,
    lpReportDaysQuarterly: n(row.lp_report_days_quarterly),
    lpReportDaysAnnual: n(row.lp_report_days_annual),
  }
}

/**
 * A partial profile from a request body (camelCase or snake_case keys), as the column update to
 * write. Absent keys are left alone; null or '' clears. Returns an error message for bad input.
 */
export function parseProfilePatch(body: Record<string, unknown>): { update: Record<string, unknown> } | { error: string } {
  const pick = (camel: string, snake: string) => (camel in body ? body[camel] : body[snake])
  const has = (camel: string, snake: string) => camel in body || snake in body
  const update: Record<string, unknown> = {}

  if (has('strategy', 'strategy')) {
    const v = body.strategy
    if (v === null || v === '') update.strategy = null
    else if (typeof v === 'string' && STRATEGIES.includes(v as Strategy)) update.strategy = v
    else return { error: `strategy must be one of ${STRATEGIES.join(', ')}` }
  }
  if (has('administrator', 'administrator')) {
    const v = body.administrator
    if (v === null || v === '') update.administrator = null
    else if (typeof v === 'string' && v.trim().length <= 200) update.administrator = v.trim() || null
    else return { error: 'administrator must be a name of at most 200 characters, or "In-house"' }
  }
  for (const [camel, snake, label] of [
    ['lpReportDaysQuarterly', 'lp_report_days_quarterly', 'Quarterly LP reporting days'],
    ['lpReportDaysAnnual', 'lp_report_days_annual', 'Annual LP reporting days'],
  ] as const) {
    if (!has(camel, snake)) continue
    const v = pick(camel, snake)
    if (v === null || v === '') { update[snake] = null; continue }
    const d = Number(v)
    if (!Number.isInteger(d) || d < 1 || d > 365) return { error: `${label} must be a whole number of days, 1 to 365` }
    update[snake] = d
  }
  return { update }
}

/**
 * When LP reporting for a quarter-end is due, from the profile: the annual window for a December
 * quarter-end, the quarterly one otherwise. Null when the profile does not say.
 */
export function lpReportingDueDate(profile: VehicleProfile, quarterEnd: string): string | null {
  const annual = quarterEnd.slice(5) === '12-31'
  const days = annual ? profile.lpReportDaysAnnual ?? null : profile.lpReportDaysQuarterly ?? null
  if (days == null) return null
  const d = new Date(`${quarterEnd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Profiles for the given entities, by id. Before the migration is pushed the columns do not exist:
 * every profile reads as not set rather than failing the caller.
 */
export async function loadVehicleProfiles(admin: SupabaseClient, fundId: string, ids: string[]): Promise<Map<string, VehicleProfile>> {
  const out = new Map<string, VehicleProfile>()
  if (ids.length === 0) return out
  const { data, error } = await (admin as any).from('fund_vehicles').select(`id, ${PROFILE_COLUMNS}`).eq('fund_id', fundId).in('id', ids)
  if (error) {
    if (/column|schema cache/i.test(error.message ?? '')) return out
    throw new Error(`Entity profiles could not be read: ${error.message}`)
  }
  for (const row of (data ?? []) as Record<string, unknown>[]) out.set(String(row.id), profileFromRow(row))
  return out
}
