// The preamble every /api/fleet/ops and /api/fleet/kpis handler shares. The middleware has already
// checked `fleet` at the route's level (lib/access/route-domains.ts); this resolves the fund and the
// vehicle (entity scope and the manco rule, via resolveGroupWithAccess), then refuses any vehicle
// that is not a GPU SPV with a 404 (assertVehicleKind).

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { resolveGroupWithAccess } from '@/lib/accounting/http-vehicle'
import { assertVehicleKind, type VehicleGate } from '@/lib/accounting/vehicle-domain'
import { hasAccess, type AccessContext } from '@/lib/access/effective'

export interface FleetRequest {
  gate: VehicleGate
  group: string
  access: AccessContext
}

export async function fleetRequest(
  admin: SupabaseClient, userId: string, need: 'read' | 'write', requested: string | null | undefined,
): Promise<FleetRequest | NextResponse> {
  const gate = need === 'write' ? await assertWriteAccess(admin, userId) : await assertReadAccess(admin, userId)
  if (gate instanceof NextResponse) return gate
  const resolved = await resolveGroupWithAccess(admin, gate, requested)
  if (resolved instanceof NextResponse) return resolved
  const wrongKind = await assertVehicleKind(admin, gate.fundId, resolved.group, 'gpu_spv')
  if (wrongKind) return wrongKind
  return { gate, group: resolved.group, access: resolved.access }
}

/**
 * Posting revenue or matching a payout writes the books, so it also needs `accounting` write — the
 * `fleet` grant alone reaches the operations pages, not the ledger (DOMAIN_META.fleet).
 */
export function needsAccountingWrite(access: AccessContext, what: string): NextResponse | null {
  if (hasAccess(access, 'accounting', 'write')) return null
  return NextResponse.json({ error: `${what} needs write access to Fund accounting.` }, { status: 403 })
}
