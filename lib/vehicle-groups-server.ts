import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccessContext } from '@/lib/access/effective'
import { canSeeVehicle } from '@/lib/access/scope'
import { EMPTY_VEHICLE_GROUPS, type VehicleGroup, type VehicleGroupsPayload } from '@/lib/vehicle-groups'

// Server half of lib/vehicle-groups.ts. Read with the service role (vehicle_groups has no Data API
// grant), so the entity assignments are filtered by the caller's own access here.

/** vehicle_groups, or fund_vehicles.group_id, not migrated yet. */
export function isMissingGroupsSchema(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false
  return error.code === '42P01' || error.code === '42703' || error.code === 'PGRST204' || error.code === 'PGRST205'
    || /vehicle_groups|group_id/.test(error.message ?? '') && /does not exist|schema cache|could not find/i.test(error.message ?? '')
}

export async function loadGroups(admin: SupabaseClient, fundId: string): Promise<{ groups: VehicleGroup[]; missing: boolean }> {
  const { data, error } = await (admin as any)
    .from('vehicle_groups').select('id, name, position').eq('fund_id', fundId)
    .order('position').order('name')
  if (error) {
    if (isMissingGroupsSchema(error)) return { groups: [], missing: true }
    throw error
  }
  return { groups: (data ?? []) as VehicleGroup[], missing: false }
}

/** The groups and the caller's visible entities in them. Empty (not an error) before the migration. */
export async function loadVehicleGroups(
  admin: SupabaseClient,
  fundId: string,
  access: Pick<AccessContext, 'vehicles'>,
): Promise<VehicleGroupsPayload> {
  const { groups, missing } = await loadGroups(admin, fundId)
  if (missing || groups.length === 0) return EMPTY_VEHICLE_GROUPS

  const { data, error } = await (admin as any)
    .from('fund_vehicles').select('id, name, aliases, group_id')
    .eq('fund_id', fundId).not('group_id', 'is', null)
  if (error) {
    if (isMissingGroupsSchema(error)) return EMPTY_VEHICLE_GROUPS
    throw error
  }
  const ids = new Set(groups.map(g => g.id))
  const assignments = ((data ?? []) as { id: string; name: string; aliases: string[] | null; group_id: string }[])
    .filter(v => ids.has(v.group_id) && canSeeVehicle(access, v.id))
    .map(v => ({ vehicleId: v.id, name: v.name, aliases: v.aliases ?? [], groupId: v.group_id }))
  // A scoped caller sees only the groups holding one of their entities — a group's name can say
  // as much as an entity's ("Project Falcon SPVs").
  const used = new Set(assignments.map(a => a.groupId))
  return { groups: access.vehicles.all ? groups : groups.filter(g => used.has(g.id)), assignments }
}
