// The allocation basis on a partnership-expense invoice line: why the fund bears this expense
// ("100% Fund III: annual audit", "pro rata by commitment"). It is printed on the invoice.
//
// Where a line's basis comes from, first match wins:
//   1. typed on the invoice line before the invoice is created (frozen onto the line)
//   2. typed on the receipt behind the expense (receipts.allocation_basis)
//   3. saved for that vendor, for that biller and fund (partnership_allocation_rules)
// Once an invoice is created the basis lives on its line, so a rule changed later never rewrites
// an invoice already sent.

import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * A vendor name reduced for matching: lower case, punctuation to spaces, spaces squeezed. Receipts
 * carry the vendor as typed or read off the page, entries carry the vendors table's name; this is
 * what lets "ACME Legal, LLP" on one match "Acme Legal LLP" on the other.
 */
export function vendorKey(name: string | null | undefined): string {
  return String(name ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

export type AllocationSource = 'receipt' | 'vendor'

/** The basis a line starts with, and where it came from, before anyone types over it. */
export function startingAllocationBasis(
  receiptBasis: string | null | undefined,
  vendorName: string | null | undefined,
  rules: Map<string, string>,
): { allocationBasis: string | null; allocationSource: AllocationSource | null } {
  const typed = receiptBasis?.trim()
  if (typed) return { allocationBasis: typed, allocationSource: 'receipt' }
  const saved = rules.get(vendorKey(vendorName))
  return saved ? { allocationBasis: saved, allocationSource: 'vendor' } : { allocationBasis: null, allocationSource: null }
}

/** The saved bases for what one entity bills one fund, by vendor key. */
export async function allocationRules(admin: SupabaseClient, fundId: string, fromVehicleId: string, toVehicleId: string): Promise<Map<string, string>> {
  const { data } = await admin.from('partnership_allocation_rules' as any)
    .select('vendor_key, allocation_basis')
    .eq('fund_id', fundId).eq('from_vehicle_id', fromVehicleId).eq('to_vehicle_id', toVehicleId)
  return new Map(((data as any[]) ?? []).map(r => [r.vendor_key as string, r.allocation_basis as string]))
}

/** Save (or replace) the basis for a vendor's expenses that one entity bills one fund. */
export async function saveAllocationRule(
  admin: SupabaseClient,
  fundId: string,
  userId: string | null,
  args: { fromVehicleId: string; toVehicleId: string; vendorName: string | null | undefined; allocationBasis: string | null | undefined },
): Promise<{ ok: true } | { error: string }> {
  const key = vendorKey(args.vendorName)
  const basis = args.allocationBasis?.trim()
  if (!key) return { error: 'An expense with no vendor cannot be saved for the vendor’s future expenses.' }
  if (!basis) return { error: 'Type the allocation basis first.' }
  const { error } = await admin.from('partnership_allocation_rules' as any).upsert({
    fund_id: fundId,
    from_vehicle_id: args.fromVehicleId,
    to_vehicle_id: args.toVehicleId,
    vendor_key: key,
    vendor_name: String(args.vendorName).trim(),
    allocation_basis: basis,
    updated_by: userId,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'fund_id,from_vehicle_id,to_vehicle_id,vendor_key' })
  return error ? { error: `The allocation basis could not be saved: ${error.message}` } : { ok: true }
}
