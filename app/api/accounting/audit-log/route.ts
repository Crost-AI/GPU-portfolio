import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { hasAccess, loadAccessContext } from '@/lib/access/effective'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { resolveVehicleWithAccess, VehicleAccessError } from '@/lib/accounting/http-vehicle'
import { VehicleResolutionError } from '@/lib/accounting/vehicle-resolver'
import { isManagementCompany } from '@/lib/vehicle-kinds'
import { canSeeVehicle, visibleVehicleIds } from '@/lib/access/scope'
import { auditCsv, loadAuditTrail, visibleTo } from '@/lib/audit/read'
import { parseChangeSource } from '@/lib/audit/source-labels'

// GET — the books' audit trail (accounting_audit_events): voids, unposts, reversals, period closes,
// reopens and approvals, commitment edits, shared reports, calls, distributions, K-1s.
//
//   ?group=<entity>   one entity's events (omit for the whole firm)
//   ?from=&to=        YYYY-MM-DD bounds
//   ?source=web|api|mcp  only changes made through that door
//   ?format=csv       the same rows as a download, for an auditor
//
// Gated on accounting read (route-domains.ts). Events carrying partner figures or the carry are
// dropped for a caller without lp_capital / gp_economics, tax events without tax_reporting, and
// staged-action events without the action's own domain (lib/audit/read.ts visibleTo). A management
// company's events — named with ?group= or in the firm-wide trail — need the management_company
// grant: the `accounting` gate this route sits behind says nothing about the firm's own books.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const sp = req.nextUrl.searchParams
  const date = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)
  const group = sp.get('group')
  const access = await loadAccessContext(admin, gate.fundId, user.id, gate.role)
  let vehicleId: string | null = null
  if (group) {
    // Through resolveVehicleWithAccess, not a bare name lookup: it opts in to management companies
    // AND refuses one without the management_company grant.
    try {
      const { name } = await resolveVehicleWithAccess(admin, access, group, 'read')
      vehicleId = await vehicleIdByName(admin, gate.fundId, name)
    } catch (e) {
      if (e instanceof VehicleAccessError) return NextResponse.json({ error: e.message }, { status: 403 })
      if (e instanceof VehicleResolutionError) return NextResponse.json({ error: e.message }, { status: 400 })
      throw e
    }
    if (!vehicleId) return NextResponse.json({ error: `Unknown entity "${group}"` }, { status: 400 })
  }
  // Entity scope: one entity the caller may see, or the firm-wide trail cut to the entities they
  // may see. Events not tied to an entity are shown only to a caller who sees every entity.
  if (vehicleId && !canSeeVehicle(access, vehicleId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const visible = visibleVehicleIds(access)
  const csv = sp.get('format') === 'csv'
  const { data: vehicles, error: vehiclesError } = await admin.from('fund_vehicles' as any).select('id, name, kind').eq('fund_id', gate.fundId)
  if (vehiclesError) return NextResponse.json({ error: 'Failed to load entities' }, { status: 500 })
  const vehicleRows = ((vehicles as any[]) ?? [])
  const manco = hasAccess(access, 'management_company', 'read')
    ? new Set<string>()
    : new Set(vehicleRows.filter(v => isManagementCompany(v.kind)).map(v => v.id as string))
  const byAction = visibleTo(access)
  // Filtered before the limit is applied, so a page is never short for rows the caller can't see.
  const allowed = (action: string, details?: Record<string, unknown> | null, vid?: string | null) =>
    byAction(action, details)
    && (visible === null || (vid != null && visible.includes(vid)))
    && (vid == null || !manco.has(vid))
  const rows = await loadAuditTrail(admin, gate.fundId, { vehicleId, from: date(sp.get('from')), to: date(sp.get('to')), source: parseChangeSource(sp.get('source')), limit: csv ? undefined : Math.min(500, Number(sp.get('limit')) || 100) }, allowed)

  if (!csv) return NextResponse.json({ events: rows })
  const names = new Map(vehicleRows.map(v => [v.id as string, v.name as string]))
  const file = `audit-trail${group ? `-${group.replace(/[^\w.-]+/g, '-')}` : ''}-${new Date().toISOString().slice(0, 10)}.csv`
  return new NextResponse(auditCsv(rows, names), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${file}"` },
  })
}
