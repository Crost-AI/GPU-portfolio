/**
 * Entity groups — the admin-defined sections the entity lists render in (vehicle_groups,
 * fund_vehicles.group_id). Dependency-free so a client list can import it; the server half is
 * lib/vehicle-groups-server.ts.
 *
 * A list row is matched to its group by entity id first and by name second, because several lists
 * still key on the `portfolio_group` string and a legacy row may carry an old spelling (an alias).
 */

export interface VehicleGroup {
  id: string
  name: string
  position: number
}

/** One entity that sits in a group. Entities in no group are not listed — they fall to "Other". */
export interface VehicleGroupAssignment {
  vehicleId: string
  name: string
  aliases: string[]
  groupId: string
}

export interface VehicleGroupsPayload {
  groups: VehicleGroup[]
  assignments: VehicleGroupAssignment[]
}

export const EMPTY_VEHICLE_GROUPS: VehicleGroupsPayload = { groups: [], assignments: [] }

/** The heading for entities in no group. */
export const UNGROUPED_LABEL = 'Other'

export interface GroupSection<T> {
  /** Null for the "Other" section, and for the single section of an ungrouped list. */
  group: VehicleGroup | null
  /** The section's heading. */
  label: string
  items: T[]
}

export interface GroupKey {
  id?: string | null
  name?: string | null
}

const norm = (s: string) => s.trim().toLowerCase()

/** A resolver from a row's id/name to its group, or null for "Other". */
export function groupResolver(payload: VehicleGroupsPayload): (key: GroupKey) => VehicleGroup | null {
  const byId = new Map(payload.groups.map(g => [g.id, g]))
  const byVehicle = new Map<string, VehicleGroup>()
  const byName = new Map<string, VehicleGroup>()
  for (const a of payload.assignments) {
    const g = byId.get(a.groupId)
    if (!g) continue
    byVehicle.set(a.vehicleId, g)
    for (const n of [a.name, ...a.aliases]) if (n) byName.set(norm(n), g)
  }
  return ({ id, name }) => (id && byVehicle.get(id)) || (name && byName.get(norm(name))) || null
}

/**
 * Split a list into sections, one per group in `position` order, then "Other". Order WITHIN a
 * section is the order `items` came in, so a list sorts first and groups second.
 *
 * When the fund has grouped no entity the result is one section with a null group: the caller
 * renders it as the plain list it was, with no "Other" heading over everything. Empty groups are
 * dropped, and so is an empty "Other".
 */
export function groupBySection<T>(
  items: T[],
  payload: VehicleGroupsPayload,
  key: (item: T) => GroupKey,
): GroupSection<T>[] {
  const resolve = groupResolver(payload)
  const buckets = new Map<string, T[]>()
  const other: T[] = []
  for (const item of items) {
    const g = resolve(key(item))
    if (!g) { other.push(item); continue }
    const b = buckets.get(g.id)
    if (b) b.push(item)
    else buckets.set(g.id, [item])
  }
  // Flat only when the fund has grouped nothing at all. A search that happens to match only
  // ungrouped rows still says "Other", so the heading does not come and go as you type.
  if (payload.assignments.length === 0) return [{ group: null, label: UNGROUPED_LABEL, items }]

  const ordered = [...payload.groups].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
  const sections: GroupSection<T>[] = ordered
    .filter(g => buckets.has(g.id))
    .map(g => ({ group: g, label: g.name, items: buckets.get(g.id)! }))
  if (other.length > 0) sections.push({ group: null, label: UNGROUPED_LABEL, items: other })
  return sections
}

/** True when a sectioned list should show headings at all. */
export function isGrouped<T>(sections: GroupSection<T>[], payload: VehicleGroupsPayload): boolean {
  return payload.assignments.length > 0 && sections.some(s => s.items.length > 0)
}
