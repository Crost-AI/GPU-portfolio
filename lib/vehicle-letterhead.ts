import type { SupabaseClient } from '@supabase/supabase-js'

// Per-vehicle letterhead: logo, name and address (fund_vehicles.logo_url, letterhead_name,
// letterhead_address — 20261012120000_vehicle_letterhead.sql).
//
// A firm can administer a vehicle that has its own brand: 3SE Holdings is run from this fund's
// books, but its LPs know it as 3SE, not as the firm. So an LP-facing PDF about ONE vehicle (a
// capital account statement, a call or distribution notice, a receipt, a letter) carries that
// vehicle's letterhead where it has one, and the fund's otherwise. A document spanning several
// vehicles (an investor report) uses a vehicle's value only when every vehicle on it shares it: an
// LP who is only in 3SE vehicles gets 3SE's letterhead, one also in the flagship gets the fund's.
//
// Each of the three parts falls back on its own, so a vehicle with only a logo set still prints
// the fund's name and address.
//
// Logos are data URIs only: a remote URL silently fails to render inside headless Chrome, which is
// the same constraint the fund logo carries.

export interface Letterhead {
  logo: string | null
  name: string
  address: string | null
}

export interface VehicleLetterhead {
  logo: string | null
  name: string | null
  address: string | null
}

export function safeLogo(v: unknown): string | null {
  return typeof v === 'string' && v.startsWith('data:image/') ? v : null
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** The fund's own letterhead, from a `funds` row (name, logo_url, address). */
export function fundLetterhead(fund: { name?: unknown; logo_url?: unknown; address?: unknown } | null | undefined): Letterhead {
  return { logo: safeLogo(fund?.logo_url), name: text(fund?.name) ?? '', address: text(fund?.address) }
}

/**
 * Vehicle name (and every alias) → letterhead, for the vehicles in this fund that set any part of
 * one. Empty when the columns are not migrated yet, so every caller degrades to the fund's.
 */
export async function loadVehicleLetterheads(admin: SupabaseClient, fundId: string): Promise<Map<string, VehicleLetterhead>> {
  const out = new Map<string, VehicleLetterhead>()
  const { data, error } = await (admin as any)
    .from('fund_vehicles')
    .select('name, aliases, logo_url, letterhead_name, letterhead_address')
    .eq('fund_id', fundId)
    .or('logo_url.not.is.null,letterhead_name.not.is.null,letterhead_address.not.is.null')
  if (error) return out
  for (const v of (data as any[]) ?? []) {
    const lh: VehicleLetterhead = { logo: safeLogo(v.logo_url), name: text(v.letterhead_name), address: text(v.letterhead_address) }
    if (!lh.logo && !lh.name && !lh.address) continue
    out.set(v.name, lh)
    for (const a of (v.aliases as string[] | null) ?? []) if (!out.has(a)) out.set(a, lh)
  }
  return out
}

/** The value every vehicle shares, or null when any lacks it or they differ. */
function shared(values: (string | null)[]): string | null {
  if (values.length === 0) return null
  return values.every(v => v !== null && v === values[0]) ? values[0] : null
}

/** The letterhead for a document covering `groups`: per part, the vehicles' shared value, else the fund's. */
export function pickLetterhead(fund: Letterhead, groups: string[], vehicles: Map<string, VehicleLetterhead>): Letterhead {
  const distinct = Array.from(new Set(groups.filter(Boolean)))
  const parts = distinct.map(g => vehicles.get(g))
  return {
    logo: shared(parts.map(p => p?.logo ?? null)) ?? fund.logo,
    name: shared(parts.map(p => p?.name ?? null)) ?? fund.name,
    address: shared(parts.map(p => p?.address ?? null)) ?? fund.address,
  }
}

/** Convenience for a single document. */
export async function documentLetterhead(
  admin: SupabaseClient, fundId: string,
  fund: { name?: unknown; logo_url?: unknown; address?: unknown } | null | undefined,
  groups: string[],
): Promise<Letterhead> {
  return pickLetterhead(fundLetterhead(fund), groups, await loadVehicleLetterheads(admin, fundId))
}
