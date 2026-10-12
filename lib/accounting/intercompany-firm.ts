import type { SupabaseClient } from '@supabase/supabase-js'
import { intercompanyBalances, type IntercompanyBalance } from './intercompany'
import type { FirmEntity } from './firm-entities'

// WHO OWES WHOM INSIDE A FAMILY OF ENTITIES — and whether both sides' books agree.
//
// Each entity's intercompany balances come from its own ledger (its 1900-<cp> and 2900-<cp>
// accounts). An amount the GP says the fund owes it should be the amount the fund says it owes
// the GP; when the two ledgers disagree, one of them is missing an entry, and this is the one
// place both sides are read together. For the family page (/funds/group/<id>).

export interface IntercompanyPair {
  /** The entity whose books report the balance. */
  vehicleId: string
  counterpartyVehicleId: string
  counterpartyName: string
  /** What `vehicleId` is owed by the counterparty, net of what it owes it. */
  net: number
  /** The same balance from the counterparty's books, sign-flipped to `vehicleId`'s side; null when the counterparty is not in the family or not visible. */
  counterpartyNet: number | null
  /** Both sides read and agree to the cent. Null when only one side could be read. */
  ties: boolean | null
}

const r = (n: number) => Math.round(n * 100) / 100

/**
 * Pair up each entity's balances with its counterparty's. A pair inside the family is reported
 * once, from the entity that sorts first, so A→B and B→A are not both listed. Pure.
 */
export function pairIntercompany(byEntity: Map<string, IntercompanyBalance[]>, order: string[]): IntercompanyPair[] {
  const rank = new Map(order.map((id, i) => [id, i]))
  const out: IntercompanyPair[] = []
  for (const id of order) {
    for (const b of byEntity.get(id) ?? []) {
      const inFamily = rank.has(b.counterpartyVehicleId)
      if (inFamily && rank.get(b.counterpartyVehicleId)! < rank.get(id)!) continue
      const other = inFamily ? (byEntity.get(b.counterpartyVehicleId) ?? []).find(x => x.counterpartyVehicleId === id) : undefined
      const counterpartyNet = inFamily ? r(-(other?.net ?? 0)) : null
      out.push({
        vehicleId: id,
        counterpartyVehicleId: b.counterpartyVehicleId,
        counterpartyName: b.counterpartyName,
        net: r(b.net),
        counterpartyNet,
        ties: counterpartyNet == null ? null : Math.abs(counterpartyNet - b.net) < 0.005,
      })
    }
    // A balance only the counterparty carries: this entity's books have nothing for it.
    for (const [otherId, list] of byEntity) {
      if (!rank.has(otherId) || rank.get(otherId)! <= rank.get(id)!) continue
      const theirs = list.find(x => x.counterpartyVehicleId === id)
      if (!theirs || (byEntity.get(id) ?? []).some(x => x.counterpartyVehicleId === otherId)) continue
      if (Math.abs(theirs.net) < 0.005) continue
      out.push({
        vehicleId: id, counterpartyVehicleId: otherId, counterpartyName: '',
        net: 0, counterpartyNet: r(-theirs.net), ties: false,
      })
    }
  }
  return out.filter(p => Math.abs(p.net) >= 0.005 || (p.counterpartyNet != null && Math.abs(p.counterpartyNet) >= 0.005))
}

export async function loadFamilyIntercompany(admin: SupabaseClient, fundId: string, members: FirmEntity[]): Promise<IntercompanyPair[]> {
  const balances = await Promise.all(members.map(async m => [m.id, await intercompanyBalances(admin, fundId, m.name)] as const))
  const pairs = pairIntercompany(new Map(balances), members.map(m => m.id))
  // Name the counterparty where only its own books carried the balance.
  const names = new Map(members.map(m => [m.id, m.name]))
  return pairs.map(p => (p.counterpartyName ? p : { ...p, counterpartyName: names.get(p.counterpartyVehicleId) ?? '' }))
}
