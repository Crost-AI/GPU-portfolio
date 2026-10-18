import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { hasAccess, loadAccessContext, type AccessContext } from '@/lib/access/effective'
import { isGpuSpv, isManagementCompany, type VehicleKind } from '@/lib/vehicle-kinds'
import type { Domain } from '@/lib/access/domains'

/**
 * WHICH GRANT A REQUEST FOR A VEHICLE'S BOOKS NEEDS — decided by the vehicle, not by the route.
 *
 * Every other gate in this app answers "may this caller call this route?" and the answer is the
 * same for every row the route can reach. Accounting is the one place that isn't true. A
 * management company's ledger is stored in the same `journal_entries`, `journal_postings` and
 * `chart_of_accounts` tables as every fund's, distinguished only by `vehicle_id` — so
 * `/api/accounting/journal?group=<the manco>` is, to the middleware, the same request as
 * `?group=<Fund II>`. It resolves `accounting`, sees a grant, and hands back the firm's payroll.
 *
 * That is the hole this closes. `resolveGroupOr400` — which all 90-odd accounting call sites
 * already use to work out WHICH vehicle they are serving — now also decides whether this caller
 * may serve it. One choke point, no per-route decision to forget.
 *
 * THE RULE, stated in full:
 *
 *   - An ordinary vehicle (fund / SPV / direct / associate / other) needs `accounting`, which the
 *     middleware has already checked by the time a handler runs. Nothing extra happens, and
 *     nothing extra is loaded — the common path costs one column of one row.
 *   - A management company needs `management_company` AS WELL, at the same level the route
 *     declared. The conjunction is deliberate, and it errs safe: `accounting` alone can never
 *     reach a manco, which is the whole point of splitting the domain.
 *
 * The cost of the conjunction is that a manco-only bookkeeper cannot use the shared ledger pages
 * (journal, bank, QuickBooks) — those sit behind `/api/accounting/*`, which the middleware gates on
 * `accounting` before any of this runs. The manco module's OWN routes (`/api/manco/*`) are gated on
 * `management_company` alone and cover the dashboard, the chart, the statements and intercompany,
 * so that person has a working section; they need the fund-accounting grant only to hand-author
 * journal entries. Widening that means either moving the manco ledger into its own tables or
 * teaching the middleware to read the vehicle out of a request body — neither is worth doing to
 * save a grant, and the failure mode of getting it wrong is disclosing compensation.
 */

// The vocabulary itself lives in a dependency-free module so the pickers can import it too;
// re-exported here so a server caller has one import rather than two.
export {
  VEHICLE_KINDS, MANCO_KIND, isManagementCompany as isMancoKind, type VehicleKind,
} from '@/lib/vehicle-kinds'

/** The domain that owns a vehicle's books. */
export function domainForVehicleKind(kind: string | null | undefined): Domain {
  return isManagementCompany(kind) ? 'management_company' : 'accounting'
}

/**
 * A vehicle's kind, by name or legacy alias. Null when the fund has no such vehicle — which is not
 * an error here: a legacy portfolio_group string with no registry row still keys real ledger rows,
 * and it is an ordinary vehicle by definition (a management company can only exist by being set up
 * as one).
 */
export async function vehicleKindByName(
  admin: SupabaseClient,
  fundId: string,
  name: string,
): Promise<VehicleKind | null> {
  const { data } = await (admin as any)
    .from('fund_vehicles').select('kind').eq('fund_id', fundId).eq('name', name).maybeSingle()
  if (data) return (data.kind as VehicleKind) ?? null
  const { data: alias } = await (admin as any)
    .from('fund_vehicles').select('kind').eq('fund_id', fundId).contains('aliases', [name]).maybeSingle()
  return ((alias?.kind as VehicleKind) ?? null)
}

/**
 * `vehicleKindByName` for a guard that must fail closed: it tells "no such vehicle" (`kind` null,
 * `error` null) apart from "could not read it" (`error` set). `vehicleKindByName` keeps its
 * forgiving contract for its other callers.
 */
export async function readVehicleKindByName(
  admin: SupabaseClient,
  fundId: string,
  name: string,
): Promise<{ kind: VehicleKind | null; error: unknown }> {
  const { data, error } = await (admin as any)
    .from('fund_vehicles').select('kind').eq('fund_id', fundId).eq('name', name).maybeSingle()
  if (error) return { kind: null, error }
  if (data) return { kind: (data.kind as VehicleKind) ?? null, error: null }
  const { data: alias, error: aliasError } = await (admin as any)
    .from('fund_vehicles').select('kind').eq('fund_id', fundId).contains('aliases', [name]).maybeSingle()
  if (aliasError) return { kind: null, error: aliasError }
  return { kind: (alias?.kind as VehicleKind) ?? null, error: null }
}

/** What a gate helper (assertReadAccess / assertWriteAccess / resolveFund) hands back. */
export interface VehicleGate {
  fundId: string
  userId: string
  role: string
  /** The level the route declared by choosing its gate helper. */
  need: 'read' | 'write'
}

/**
 * Refuse a management company to a caller who holds only `accounting`. Returns null to allow.
 *
 * The extra access-context load happens ONLY for a management company — an ordinary vehicle
 * short-circuits on the kind lookup, so the hot path (every other accounting request in the app)
 * pays one extra column, not an extra round trip.
 *
 * The refusal is 403 with a message that names the grant, not a 404: pretending the vehicle does
 * not exist would be a worse lie than the one this replaces, since the caller can see the name in
 * their own vehicle list.
 *
 * `access`, when given, is this request's already-loaded context for the same gate, used instead of
 * loading it again.
 */
export async function assertVehicleDomain(
  admin: SupabaseClient,
  gate: VehicleGate,
  group: string,
  access?: AccessContext,
): Promise<NextResponse | null> {
  const kind = await vehicleKindByName(admin, gate.fundId, group)
  if (!isManagementCompany(kind)) return null

  const ctx = access ?? await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
  if (hasAccess(ctx, 'management_company', gate.need)) return null

  return NextResponse.json(
    {
      error:
        `"${group}" is a management company. Its books are gated separately from the funds' — ` +
        `ask an admin for ${gate.need} access to Management company.`,
    },
    { status: 403 },
  )
}

/**
 * The inverse, for the manco module's own routes: this vehicle must BE a management company.
 *
 * `/api/manco/*` is gated on `management_company` in ROUTE_DOMAINS, so a caller who reached the
 * handler holds that grant — but the grant says nothing about which vehicle they named, and
 * without this check `?group=<Fund II>` would read a fund's books through a manco route, i.e. the
 * same hole in the other direction.
 */
export async function assertMancoVehicle(
  admin: SupabaseClient,
  fundId: string,
  group: string,
): Promise<NextResponse | null> {
  const kind = await vehicleKindByName(admin, fundId, group)
  if (isManagementCompany(kind)) return null
  return NextResponse.json(
    { error: `"${group}" is not a management company. Fund vehicles are managed under Funds.` },
    { status: 400 },
  )
}

// ── GPU fleet (P1) ──
/**
 * The fleet routes' version of `assertMancoVehicle`: the vehicle `?group=` names must BE of `kind`.
 *
 * `/api/fleet/*` is gated on `fleet`, which says nothing about which vehicle the caller named, so
 * without this a VC SPV's books could be read through a fleet route. A legacy name with no registry
 * row has no kind and is refused. Not found rather than 400: a fleet route has nothing to say about
 * an entity that is not a GPU SPV, and saying what it is instead would be the leak.
 *
 * It checks the KIND only, not the caller's entity scope: callers still resolve the group through
 * resolveGroupOr400 (or check canSeeVehicle) first.
 */
export async function assertVehicleKind(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  kind: VehicleKind,
): Promise<NextResponse | null> {
  const actual = await vehicleKindByName(admin, fundId, group)
  if (actual === kind) return null
  return NextResponse.json({ error: 'Vehicle not found' }, { status: 404 })
}

/**
 * The one rule for a vehicle's kind and GPU-ness, shared by POST and PATCH /api/vehicles (and the
 * merge in lib/vehicles-merge.ts). Returns the refusal, or null to allow.
 *
 *   - CREATING a GPU SPV needs `fleet` write, the grant that lets the caller see what they made
 *     (403 otherwise; none while `gpu_fleet` is off, admins included).
 *   - CHANGING an existing entity into or out of a GPU SPV is refused outright (409), whatever the
 *     caller holds: a kind change does not reseed the chart, so it would leave a fund chart on a
 *     GPU SPV or the reverse. Create a new GPU SPV instead. Re-sending an unchanged kind is fine.
 */
export function gpuKindDenial(
  access: AccessContext,
  change: { existing: boolean; from?: string | null; to: string | null | undefined },
): { status: 403 | 409; error: string } | null {
  if (change.existing) {
    if (change.from === change.to || isGpuSpv(change.from) === isGpuSpv(change.to)) return null
    return { status: 409, error: GPU_KIND_CHANGE_ERROR }
  }
  if (!isGpuSpv(change.to) || hasAccess(access, 'fleet', 'write')) return null
  return { status: 403, error: 'A GPU SPV needs write access to GPU fleet. Ask an admin to turn on GPU Operations or grant it.' }
}

export const GPU_KIND_CHANGE_ERROR =
  'An entity cannot be changed into or out of a GPU SPV: its chart of accounts would not match. Create a new GPU SPV instead.'

/**
 * ── GPU fleet (P1) ── Fail closed on tax for a GPU SPV until K-1 character understands its chart.
 *
 * The tax loaders (k1-load.ts and the book-to-tax run) read the FUND chart's codes: 4000 as a
 * realized gain, 4120 as other income, 5000–5300 as deductions. On a GPU SPV 4000 is rental revenue,
 * 4500 a disposal gain (§1245 recapture) and 5150/5400/5900 are expenses those sums never see, so a
 * package would issue with income missing. Every tax route calls this with the vehicle it was
 * asked about — by `?group=` name, or by the K-1 package it names — and gets a 409 for a GPU SPV.
 * Follow-up: GitHub issue #68.
 *
 * It fails CLOSED: a lookup that errors (package, vehicle, or the name/alias pair) is a 503, never a
 * pass, because a timed-out read on a GPU SPV would otherwise let K-1 work run on its chart. Only a
 * read that succeeds and finds no row — a legacy name, an ordinary vehicle by definition — passes.
 */
export async function refuseGpuSpvTax(
  admin: SupabaseClient,
  fundId: string,
  ref: { group?: string | null; packageId?: string | null },
): Promise<NextResponse | null> {
  const unverified = () => NextResponse.json({ error: 'Could not verify the entity kind' }, { status: 503 })
  let kind: string | null = null
  if (ref.group) {
    const read = await readVehicleKindByName(admin, fundId, ref.group)
    if (read.error) return unverified()
    kind = read.kind
  } else if (ref.packageId) {
    const { data: pkg, error: pkgError } = await (admin as any)
      .from('k1_packages').select('vehicle_id').eq('fund_id', fundId).eq('id', ref.packageId).maybeSingle()
    if (pkgError) return unverified()
    if (pkg?.vehicle_id) {
      const { data: v, error: vError } = await (admin as any)
        .from('fund_vehicles').select('kind').eq('fund_id', fundId).eq('id', pkg.vehicle_id).maybeSingle()
      if (vError) return unverified()
      kind = (v?.kind as string) ?? null
    }
  }
  if (!isGpuSpv(kind)) return null
  return NextResponse.json({ error: 'Tax reporting is not yet supported for GPU SPVs' }, { status: 409 })
}
