import type { SupabaseClient } from '@supabase/supabase-js'

// Per-vehicle logos (fund_vehicles.logo_url, 20261012120000_vehicle_logo.sql).
//
// A firm can administer a vehicle that has its own brand: 3SE Holdings is run from this fund's
// books, but its LPs know it as 3SE, not as the firm. So an LP-facing PDF about ONE vehicle (a
// capital account statement, a call or distribution notice, a receipt) carries that vehicle's
// logo when it has one, and falls back to the fund's. A document spanning several vehicles (an
// investor report) uses a vehicle logo only when every vehicle on it shares the same one: an LP
// who is only in 3SE vehicles gets 3SE's mark, one who is also in the flagship gets the fund's.
//
// Only data URIs: a remote URL silently fails to render inside headless Chrome, which is the
// same constraint the fund logo carries.

export function safeLogo(v: unknown): string | null {
  return typeof v === 'string' && v.startsWith('data:image/') ? v : null
}

/**
 * Vehicle name (and every alias) → logo, for the vehicles in this fund that have one. Empty when
 * the column is not migrated yet, so every caller degrades to the fund logo.
 */
export async function loadVehicleLogos(admin: SupabaseClient, fundId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const { data, error } = await (admin as any)
    .from('fund_vehicles')
    .select('name, aliases, logo_url')
    .eq('fund_id', fundId)
    .not('logo_url', 'is', null)
  if (error) return out
  for (const v of (data as { name: string; aliases: string[] | null; logo_url: unknown }[]) ?? []) {
    const logo = safeLogo(v.logo_url)
    if (!logo) continue
    out.set(v.name, logo)
    for (const a of v.aliases ?? []) if (!out.has(a)) out.set(a, logo)
  }
  return out
}

/**
 * The logo for a document covering `groups`: the vehicles' shared logo when every one of them has
 * the same logo, otherwise the fund's.
 */
export function pickDocumentLogo(fundLogo: unknown, groups: string[], vehicleLogos: Map<string, string>): string | null {
  const distinct = Array.from(new Set(groups.filter(Boolean)))
  if (distinct.length > 0) {
    const logos = distinct.map(g => vehicleLogos.get(g) ?? null)
    if (logos.every(l => l !== null && l === logos[0])) return logos[0]
  }
  return safeLogo(fundLogo)
}

/** Convenience for the single-vehicle documents. */
export async function documentLogo(admin: SupabaseClient, fundId: string, fundLogo: unknown, groups: string[]): Promise<string | null> {
  return pickDocumentLogo(fundLogo, groups, await loadVehicleLogos(admin, fundId))
}
