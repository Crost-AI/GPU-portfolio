// The request plumbing every /api/fleet route shares: who is asking, which GPU SPV, and what they
// may do to its books. The middleware has already checked the `fleet` grant for the route and method
// (lib/access/route-domains.ts); this resolves the vehicle with the caller's entity scope exactly as
// the accounting routes do, and refuses anything that is not a GPU SPV with a 404.

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { resolveGroupWithAccess } from '@/lib/accounting/http-vehicle'
import { assertVehicleKind } from '@/lib/accounting/vehicle-domain'
import { vehicleIdByName, vehicleNameById } from '@/lib/accounting/vehicle-id'
import { hasAccess, type AccessContext } from '@/lib/access/effective'
import type { Lifecycle } from './assets'

export interface FleetRequest {
  admin: SupabaseClient
  userId: string
  fundId: string
  group: string
  vehicleId: string
  access: AccessContext
  /** What lib/gpu's lifecycle writers take. */
  ctx: Lifecycle
}

type Caller = { admin: SupabaseClient; userId: string; gate: Exclude<Awaited<ReturnType<typeof assertReadAccess>>, NextResponse> }

async function caller(need: 'read' | 'write'): Promise<Caller | NextResponse> {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = need === 'write' ? await assertWriteAccess(admin, user.id) : await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  return { admin, userId: user.id, gate }
}

async function forGroup(c: Caller, rawGroup: unknown): Promise<FleetRequest | NextResponse> {
  const resolved = await resolveGroupWithAccess(c.admin, c.gate, typeof rawGroup === 'string' ? rawGroup : null)
  if (resolved instanceof NextResponse) return resolved
  const notGpu = await assertVehicleKind(c.admin, c.gate.fundId, resolved.group, 'gpu_spv')
  if (notGpu) return notGpu
  const vehicleId = await vehicleIdByName(c.admin, c.gate.fundId, resolved.group)
  if (!vehicleId) return NextResponse.json({ error: 'Vehicle not found' }, { status: 404 })
  return {
    admin: c.admin, userId: c.userId, fundId: c.gate.fundId, group: resolved.group, vehicleId, access: resolved.access,
    ctx: { fundId: c.gate.fundId, group: resolved.group, vehicleId, userId: c.userId },
  }
}

/** The caller and their fund, for fund-level fleet data with no vehicle column (asset types). */
export async function fleetFund(need: 'read' | 'write'): Promise<{ admin: SupabaseClient; userId: string; fundId: string } | NextResponse> {
  const c = await caller(need)
  return c instanceof NextResponse ? c : { admin: c.admin, userId: c.userId, fundId: c.gate.fundId }
}

/**
 * Resolve the caller and the GPU SPV `rawGroup` names (the sole visible entity when omitted). 401
 * without a session, 403 outside the caller's entity scope, 404 for anything that is not a GPU SPV
 * (a VC entity, a manco, a legacy name).
 */
export async function fleetRequest(need: 'read' | 'write', rawGroup: unknown): Promise<FleetRequest | NextResponse> {
  const c = await caller(need)
  return c instanceof NextResponse ? c : forGroup(c, rawGroup)
}

/**
 * The same for a route addressed by a row id (`assets/[id]`, `datacenter-contracts/[id]`): the row's
 * own vehicle decides which entity is checked, so no `group` is needed and none can point elsewhere.
 */
export async function fleetRowRequest<T extends { vehicle_id: string }>(
  need: 'read' | 'write', table: 'gpu_assets' | 'datacenter_contracts', id: string,
): Promise<{ req: FleetRequest; row: T } | NextResponse> {
  const c = await caller(need)
  if (c instanceof NextResponse) return c
  const { data: row, error } = await (c.admin as any).from(table).select('*').eq('fund_id', c.gate.fundId).eq('id', id).maybeSingle()
  if (error) return NextResponse.json({ error: 'Could not read the record' }, { status: 500 })
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const name = await vehicleNameById(c.admin, c.gate.fundId, row.vehicle_id)
  if (!name) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const req = await forGroup(c, name)
  return req instanceof NextResponse ? req : { req, row: row as T }
}

/** Purchase, disposal, capex and schedule writes post to the ledger: they need `accounting` write too. */
export function requireAccountingWrite(access: AccessContext): NextResponse | null {
  return hasAccess(access, 'accounting', 'write')
    ? null
    : NextResponse.json({ error: 'Booking this to the ledger needs write access to Accounting.' }, { status: 403 })
}

/** A lib/gpu refusal as a response: 409 while another request is mid-write, else 400. */
export function refusal(r: { error: string; inProgress?: true }): NextResponse {
  return NextResponse.json({ error: r.error, ...(r.inProgress ? { inProgress: true } : {}) }, { status: r.inProgress ? 409 : 400 })
}
