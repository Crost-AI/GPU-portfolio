import type { SupabaseClient } from '@supabase/supabase-js'
import { listVehiclesWithId, listMancoVehicles } from './load'
import { MANCO_KIND } from '@/lib/vehicle-kinds'

// The entities a firm-wide section landing lists: every registered vehicle, the management
// companies for a caller who holds that grant, narrowed to what entity access lets the caller
// see. Only registered entities (with an id), because everything these landings read is keyed by
// vehicle id; a legacy name-only vehicle has nothing for them to show.

export interface FirmEntity { id: string; name: string; kind: string | null }

export interface FirmEntityScope {
  includeManco: boolean
  /** Which entities the caller may see (entity access). Omitted = all — a server-side caller. */
  visible?: (vehicleId: string | null) => boolean
}

export async function listFirmEntities(admin: SupabaseClient, fundId: string, opts: FirmEntityScope): Promise<FirmEntity[]> {
  const vehicles = await listVehiclesWithId(admin, fundId)
  const mancos = opts.includeManco ? await listMancoVehicles(admin, fundId) : []
  return [
    ...vehicles.filter((v): v is FirmEntity => !!v.id),
    ...mancos.map(m => ({ id: m.id, name: m.name, kind: MANCO_KIND as string })),
  ].filter(v => !opts.visible || opts.visible(v.id))
}
