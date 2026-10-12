import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertAdminAccess } from '@/lib/api-helpers'
import { loadAccessContext } from '@/lib/access/effective'
import { canSeeVehicle } from '@/lib/access/scope'
import { isMissingGroupsSchema, loadGroups } from '@/lib/vehicle-groups-server'
import { dbError } from '@/lib/api-error'

// Entity groups, managed by admins (Settings → Organization → Entity groups). The lists read them
// through api/vehicle-groups. One group per entity: fund_vehicles.group_id.

const MIGRATION_HINT = 'Entity groups need a database migration (vehicle_groups) that has not been applied yet.'

type AdminGate = { res: NextResponse } | { admin: ReturnType<typeof createAdminClient>; gate: { fundId: string; role: string; userId: string } }

async function gateAdmin(): Promise<AdminGate> {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { res: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const gate = await assertAdminAccess(admin, user.id)
  if (gate instanceof NextResponse) return { res: gate }
  return { admin, gate }
}

const cleanName = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '')

function writeError(error: any, context: string) {
  if (error?.code === '23505') return NextResponse.json({ error: 'A group with that name already exists.' }, { status: 409 })
  if (isMissingGroupsSchema(error)) return NextResponse.json({ error: MIGRATION_HINT }, { status: 409 })
  return dbError(error, context)
}

// GET — { groups, vehicles: [{ id, name, kind, active, groupId }], migrationPending }
export async function GET() {
  const g = await gateAdmin()
  if ('res' in g) return g.res
  const { admin, gate } = g

  let groups
  try { groups = await loadGroups(admin as any, gate.fundId) } catch (e) { return dbError(e as any, 'settings-vehicle-groups') }

  let rows = await (admin as any).from('fund_vehicles')
    .select('id, name, kind, active, group_id').eq('fund_id', gate.fundId)
    .order('active', { ascending: false }).order('name')
  if (rows.error && isMissingGroupsSchema(rows.error)) {
    rows = await (admin as any).from('fund_vehicles')
      .select('id, name, kind, active').eq('fund_id', gate.fundId)
      .order('active', { ascending: false }).order('name')
  }
  if (rows.error) return dbError(rows.error, 'settings-vehicle-groups')
  const access = await loadAccessContext(admin as any, gate.fundId, gate.userId, gate.role)
  const vehicles = ((rows.data ?? []) as any[])
    .filter(v => canSeeVehicle(access, v.id))
    .map(v => ({ id: v.id, name: v.name, kind: v.kind, active: v.active, groupId: v.group_id ?? null }))
  return NextResponse.json({ groups: groups.groups, vehicles, migrationPending: groups.missing })
}

// POST { name } — create a group, last in order.
export async function POST(req: NextRequest) {
  const g = await gateAdmin()
  if ('res' in g) return g.res
  const { admin, gate } = g
  const body = await req.json().catch(() => ({}))
  const name = cleanName(body?.name)
  if (!name || name.length > 80) return NextResponse.json({ error: 'A group needs a name of up to 80 characters.' }, { status: 400 })

  const { data: last } = await (admin as any).from('vehicle_groups').select('position')
    .eq('fund_id', gate.fundId).order('position', { ascending: false }).limit(1)
  const position = ((last as any[])?.[0]?.position ?? -1) + 1
  const { data, error } = await (admin as any).from('vehicle_groups')
    .insert({ fund_id: gate.fundId, name, position }).select('id, name, position').single()
  if (error) return writeError(error, 'settings-vehicle-groups')
  return NextResponse.json(data)
}

// PATCH — one of:
//   { id, name }                 rename a group
//   { order: [groupId, ...] }    reorder the groups
//   { vehicleId, groupId|null }  put an entity in a group, or back in "Other"
export async function PATCH(req: NextRequest) {
  const g = await gateAdmin()
  if ('res' in g) return g.res
  const { admin, gate } = g
  const body = await req.json().catch(() => ({}))
  const now = new Date().toISOString()

  if (typeof body?.vehicleId === 'string') {
    const groupId = body.groupId == null || body.groupId === '' ? null : String(body.groupId)
    const { data: v } = await (admin as any).from('fund_vehicles').select('id')
      .eq('id', body.vehicleId).eq('fund_id', gate.fundId).maybeSingle()
    const access = await loadAccessContext(admin as any, gate.fundId, gate.userId, gate.role)
    if (!v || !canSeeVehicle(access, body.vehicleId)) return NextResponse.json({ error: 'Entity not found' }, { status: 404 })
    if (groupId) {
      const { data: grp, error } = await (admin as any).from('vehicle_groups').select('id')
        .eq('id', groupId).eq('fund_id', gate.fundId).maybeSingle()
      if (error) return writeError(error, 'settings-vehicle-groups')
      if (!grp) return NextResponse.json({ error: 'Group not found' }, { status: 404 })
    }
    const { error } = await (admin as any).from('fund_vehicles')
      .update({ group_id: groupId, updated_at: now }).eq('id', body.vehicleId).eq('fund_id', gate.fundId)
    if (error) return writeError(error, 'settings-vehicle-groups')
    return NextResponse.json({ ok: true })
  }

  if (Array.isArray(body?.order)) {
    const order = (body.order as unknown[]).map(String)
    const { data: existing, error } = await (admin as any).from('vehicle_groups').select('id').eq('fund_id', gate.fundId)
    if (error) return writeError(error, 'settings-vehicle-groups')
    const ids = new Set(((existing as any[]) ?? []).map(r => r.id as string))
    if (order.length !== ids.size || new Set(order).size !== order.length || order.some(id => !ids.has(id))) {
      return NextResponse.json({ error: 'order must list every group once' }, { status: 400 })
    }
    for (const [position, id] of order.entries()) {
      const { error: upErr } = await (admin as any).from('vehicle_groups')
        .update({ position, updated_at: now }).eq('id', id).eq('fund_id', gate.fundId)
      if (upErr) return writeError(upErr, 'settings-vehicle-groups')
    }
    return NextResponse.json({ ok: true })
  }

  if (typeof body?.id === 'string') {
    const name = cleanName(body.name)
    if (!name || name.length > 80) return NextResponse.json({ error: 'A group needs a name of up to 80 characters.' }, { status: 400 })
    const { data, error } = await (admin as any).from('vehicle_groups')
      .update({ name, updated_at: now }).eq('id', body.id).eq('fund_id', gate.fundId)
      .select('id, name, position').maybeSingle()
    if (error) return writeError(error, 'settings-vehicle-groups')
    if (!data) return NextResponse.json({ error: 'Group not found' }, { status: 404 })
    return NextResponse.json(data)
  }

  return NextResponse.json({ error: 'Nothing to change' }, { status: 400 })
}

// DELETE { id } — remove a group. Its entities go back to "Other" (on delete set null).
export async function DELETE(req: NextRequest) {
  const g = await gateAdmin()
  if ('res' in g) return g.res
  const { admin, gate } = g
  const body = await req.json().catch(() => ({}))
  if (typeof body?.id !== 'string') return NextResponse.json({ error: 'id is required' }, { status: 400 })
  const { data, error } = await (admin as any).from('vehicle_groups')
    .delete().eq('id', body.id).eq('fund_id', gate.fundId).select('id')
  if (error) return writeError(error, 'settings-vehicle-groups')
  if (!((data as any[]) ?? []).length) return NextResponse.json({ error: 'Group not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
