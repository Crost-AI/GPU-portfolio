// Turning what an assistant is handed (names, emails) into the ids the shared write functions take.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccessContext } from '@/lib/access/effective'
import { resolveVehicleWithAccess } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'

/** An entity the caller can see, by name or id, as its id. Throws a user-worded error otherwise. */
export async function visibleVehicleId(admin: SupabaseClient, access: AccessContext, ref: string): Promise<string> {
  const { name } = await resolveVehicleWithAccess(admin, access, ref, 'read')
  const id = await vehicleIdByName(admin, access.fundId, name)
  if (!id) throw new Error(`No entity named "${ref}".`)
  return id
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A member of this fund, by user id, email or display name, as their user id. Ambiguity is an
 * error naming the candidates: assigning a deal to the wrong partner is not a safe guess.
 */
export async function fundMemberId(admin: SupabaseClient, fundId: string, ref: string): Promise<string> {
  const needle = ref.trim().toLowerCase()
  if (!needle) throw new Error('Name the team member.')
  const { data } = await (admin as any).from('fund_members').select('user_id, display_name').eq('fund_id', fundId)
  const members = ((data ?? []) as Array<{ user_id: string; display_name: string | null }>)
  if (UUID.test(needle)) {
    const m = members.find(x => x.user_id.toLowerCase() === needle)
    if (m) return m.user_id
  }
  const withEmail = await Promise.all(members.map(async m => {
    const { data: u } = await (admin as any).auth.admin.getUserById(m.user_id)
    return { ...m, email: (u?.user?.email as string | undefined)?.toLowerCase() ?? null }
  }))
  const byEmail = withEmail.find(m => m.email === needle)
  if (byEmail) return byEmail.user_id
  const byName = withEmail.filter(m => (m.display_name ?? '').trim().toLowerCase() === needle
    || (m.display_name ?? '').toLowerCase().split(/\s+/).includes(needle))
  if (byName.length === 1) return byName[0].user_id
  if (byName.length > 1) {
    throw new Error(`"${ref}" matches ${byName.length} team members: ${byName.map(m => m.email ?? m.display_name).join(', ')}. Use their email.`)
  }
  throw new Error(`No team member "${ref}" in this fund.`)
}
