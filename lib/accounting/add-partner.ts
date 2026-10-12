// Adding a partner (LP or GP) to a vehicle — shared by the accounting "Add partner" form
// (app/api/accounting/lps) and the agent's add_partner tool, so both go through one path.

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadCommitmentEvents, recordCommitmentChange, savePartnerTerm, loadPartnerTerms } from './terms'
import { ensureCapitalAccounts } from './persist'
import { vehicleIdByName } from './vehicle-id'

export interface AddPartnerInput {
  name: string
  partnerClass: 'gp' | 'lp'
  commitment: number
  closingId?: string | null
}

export type AddPartnerResult =
  | { ok: true; entityId: string; partnerClass: 'gp' | 'lp' }
  | { error: string; status: number }

/** A database error: logged in full, returned generically so table details don't leak. */
function failed(error: { message: string }): { error: string; status: number } {
  console.error('[accounting-lps]', error.message)
  return { error: 'An unexpected error occurred.', status: 500 }
}

/** Validate a request body or tool input. */
export function parseAddPartnerInput(raw: any): AddPartnerInput | { error: string; status: number } {
  const name = String(raw?.name ?? '').trim()
  if (!name) return { error: 'A name is required', status: 400 }
  const partnerClass = raw?.partnerClass === 'gp' ? 'gp' : 'lp'
  const commitment = Number(raw?.commitment ?? 0)
  if (!Number.isFinite(commitment) || commitment < 0) return { error: 'A valid commitment is required', status: 400 }
  const closingId = typeof raw?.closingId === 'string' && raw.closingId ? raw.closingId : null
  return { name, partnerClass, commitment, closingId }
}

// A GP entity does not bear the management fee or carried interest; an LP entity bears both.
// Sets BOTH directions (not just gp->disable) so a gp->lp class switch re-enables participation —
// the original create-path block only ever disabled, since a partner's class never changed there.
export async function applyPartnerClassTerms(admin: SupabaseClient, fundId: string, group: string, entityId: string, partnerClass: 'gp' | 'lp') {
  const participates = partnerClass === 'lp'
  // A class switch changes ONLY participation — preserve any negotiated weight/rate overrides
  // (a read-modify-write), otherwise flipping GP<->LP would silently null out a partner's
  // custom management-fee rate or carry weight.
  const existing = await loadPartnerTerms(admin, fundId, group)
  for (const category of ['management_fee', 'carried_interest'] as const) {
    const prev = existing.find(t => t.lpEntityId === entityId && t.category === category)
    await savePartnerTerm(admin, fundId, group, {
      lpEntityId: entityId,
      category,
      participates,
      weightOverride: prev?.weightOverride ?? null,
      rateOverride: prev?.rateOverride ?? null,
      memo: `${partnerClass.toUpperCase()} entity — set on class change`,
    })
  }
}

// Reuses the investor/entity if they already exist (names are unique per fund), sets the
// entity's partner class, and records the commitment. The commitment is attached to the fund's
// latest snapshot so the partner also shows up in LP reporting; if there's no snapshot yet, null
// is fine — accounting reads investments by vehicle regardless of snapshot.
export async function addPartner(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  userId: string | null,
  input: AddPartnerInput,
): Promise<AddPartnerResult> {
  const { name, partnerClass, commitment } = input

  // Investor — reuse by name (unique per fund) or create.
  const { data: existingInv } = await admin.from('lp_investors' as any).select('id').eq('fund_id', fundId).eq('name', name).maybeSingle()
  let investorId = (existingInv as any)?.id
  if (!investorId) {
    const { data: inv, error } = await admin.from('lp_investors' as any).insert({ fund_id: fundId, name }).select('id').single()
    if (error) return failed(error)
    investorId = (inv as any).id
  }

  // Entity — reuse by name (unique per fund) or create; set its partner class.
  const { data: existingEnt } = await admin.from('lp_entities' as any).select('id').eq('fund_id', fundId).eq('entity_name', name).maybeSingle()
  let entityId = (existingEnt as any)?.id
  if (entityId) {
    await admin.from('lp_entities' as any).update({ partner_class: partnerClass }).eq('id', entityId)
  } else {
    const { data: ent, error } = await admin.from('lp_entities' as any)
      .insert({ fund_id: fundId, investor_id: investorId, entity_name: name, partner_class: partnerClass, onboarding_excluded: partnerClass === 'gp' })
      .select('id').single()
    if (error) return failed(error)
    entityId = (ent as any).id
  }

  // Every LP gets their own capital account (3100-<lp>) the moment they're entered, so
  // contributions and commitment transfers post to the partner rather than the pooled
  // "LP (unallocated)" bucket. The bulk onboarding action does the same for existing LPs.
  await ensureCapitalAccounts(admin, fundId, group, [entityId])

  // Commitment — attach to the fund's latest snapshot if there is one.
  const { data: snap } = await admin.from('lp_snapshots' as any).select('id').eq('fund_id', fundId).order('created_at', { ascending: false }).limit(1).maybeSingle()
  const snapshotId = (snap as any)?.id ?? null

  const { data: existingInvst } = await admin.from('lp_investments' as any)
    .select('id').eq('fund_id', fundId).eq('entity_id', entityId).eq('portfolio_group', group).limit(1)
  if (Array.isArray(existingInvst) && existingInvst.length > 0) {
    await admin.from('lp_investments' as any).update({ commitment }).eq('id', (existingInvst[0] as any).id)
  } else {
    const { error } = await admin.from('lp_investments' as any).insert({
      fund_id: fundId,
      entity_id: entityId,
      portfolio_group: group,
      commitment,
      snapshot_id: snapshotId,
    })
    if (error) return failed(error)
  }

  // ALSO RECORD THE COMMITMENT AS AN EVENT.
  //
  // Commitment has two readers: capital calls / fees / statements read the
  // `lp_investments.commitment` scalar, while the CLOSE allocates on `commitment_events`
  // (whenever any exist). This route only ever wrote the scalar — so a partner added here was
  // called pro-rata like everyone else, but the close allocated them nothing at all, because
  // as far as `commitmentsAsOf()` was concerned they had no commitment. Writing both keeps the
  // two readers agreeing.
  //
  // Only when the vehicle already uses events: seeding the very first event on a vehicle that
  // has none would flip the close from its scalar fallback onto an event history containing
  // this one partner and nobody else.
  if (commitment > 0) {
    const existingEvents = await loadCommitmentEvents(admin, fundId, group)
    const alreadyHas = existingEvents.some(e => e.lpEntityId === entityId)
    if (existingEvents.length > 0 && !alreadyHas) {
      const res = await recordCommitmentChange(admin, fundId, group, userId, {
        lpEntityId: entityId,
        // Dated today: this partner is being admitted now, and must not retroactively pick up
        // allocations from periods before they existed.
        effectiveDate: new Date().toISOString().slice(0, 10),
        amount: commitment,
        memo: 'Initial commitment — added via Accounting',
      })
      if ('error' in res) return { error: res.error, status: 400 }
    }
  }

  // A GP entity does not bear the management fee or carried interest. Those defaults were
  // seeded ONCE, by migration, for the GPs that existed then — so any GP added afterwards was
  // silently charged both at the next close unless somebody remembered the terms page.
  await applyPartnerClassTerms(admin, fundId, group, entityId, partnerClass)

  // Admission: which closing this partner came in at. Optional, and only a closing of THIS
  // vehicle in THIS fund — the closing id arrives in the body and proves nothing by itself.
  if (input.closingId) {
    const vehicleId = await vehicleIdByName(admin, fundId, group)
    const { data: closing } = await admin.from('vehicle_closings' as any).select('id')
      .eq('id', input.closingId).eq('fund_id', fundId).eq('vehicle_id', vehicleId).maybeSingle()
    if (!closing) return { error: 'Closing not found for this vehicle', status: 400 }
    const { error: memErr } = await admin.from('vehicle_closing_members' as any)
      .insert({ fund_id: fundId, closing_id: input.closingId, lp_entity_id: entityId })
    if (memErr && memErr.code !== '23505') return failed(memErr)
  }

  return { ok: true, entityId, partnerClass }
}
