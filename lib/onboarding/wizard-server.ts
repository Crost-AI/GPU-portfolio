/**
 * Server half of the first-run wizard (see lib/onboarding/wizard.ts for the pure half).
 * Imported only by app/api/onboarding/** route handlers.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/crypto'
import { ensureVehicleAccounts } from '@/lib/accounting/provision-accounts'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { isVehicleKind, type VehicleKind } from '@/lib/vehicle-kinds'
import { parseOnboardingRecord, type OnboardingRecord } from './wizard'

type Admin = SupabaseClient

/**
 * The Postmark webhook token, decrypted. Onboarding has only ever written the `_encrypted` column;
 * the plaintext `postmark_webhook_token` is a legacy fallback for funds that predate envelope
 * encryption — the same order /api/settings reads them in. Returns null when there is none or it
 * cannot be decrypted. CALLERS MUST HAVE CHECKED THE ADMIN ROLE: this is a credential.
 */
export function readWebhookToken(settings: {
  postmark_webhook_token_encrypted?: string | null
  encryption_key_encrypted?: string | null
  postmark_webhook_token?: string | null
} | null | undefined): string | null {
  if (!settings) return null
  const legacy = settings.postmark_webhook_token || null
  if (settings.postmark_webhook_token_encrypted && settings.encryption_key_encrypted) {
    const kek = process.env.ENCRYPTION_KEY
    if (!kek) return legacy
    try {
      const dek = decrypt(settings.encryption_key_encrypted, kek)
      return decrypt(settings.postmark_webhook_token_encrypted, dek)
    } catch {
      return legacy
    }
  }
  return legacy
}

/** PostgREST / Postgres "that column does not exist" — the onboarding migration not yet applied. */
export function isMissingOnboardingColumn(error: { message?: string; code?: string } | null | undefined): boolean {
  if (!error) return false
  const msg = error.message ?? ''
  return /onboarding/.test(msg) && (error.code === '42703' || error.code === 'PGRST204' || /column|schema cache/i.test(msg))
}

/**
 * Merge `patch` into fund_settings.onboarding. Read-merge-write: the wizard is one admin clicking
 * through steps, not a contended row. A missing column (migration pending) is not an error — the
 * wizard still works, it just can't remember a skip across a refresh.
 */
export async function patchOnboardingRecord(
  admin: Admin,
  fundId: string,
  patch: (current: OnboardingRecord) => OnboardingRecord,
): Promise<{ ok: true; persisted: boolean } | { ok: false; error: string }> {
  const { data, error: readError } = await (admin as any)
    .from('fund_settings').select('*').eq('fund_id', fundId).maybeSingle()
  if (readError) return { ok: false, error: 'Failed to read fund settings' }
  if (!data) return { ok: false, error: 'Fund settings not found' }
  if (!('onboarding' in data)) return { ok: true, persisted: false }

  const next = patch(parseOnboardingRecord(data.onboarding) ?? {})
  const { error } = await (admin as any)
    .from('fund_settings').update({ onboarding: next }).eq('fund_id', fundId)
  if (error) {
    if (isMissingOnboardingColumn(error)) return { ok: true, persisted: false }
    return { ok: false, error: 'Failed to save progress' }
  }
  return { ok: true, persisted: true }
}

export interface FirstEntityInput {
  name: string
  kind: VehicleKind
  vintageYear: number | null
}

/** Validate the "first fund entity" fields. Same rules as POST/PATCH /api/vehicles. */
export function parseFirstEntity(raw: unknown): FirstEntityInput | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'Entity details are required' }
  const r = raw as Record<string, unknown>
  const name = typeof r.name === 'string' ? r.name.trim() : ''
  if (!name) return { error: 'Entity name is required' }
  if (name.length > 200) return { error: 'Entity name is too long' }
  const kind = r.kind === undefined || r.kind === null || r.kind === '' ? 'fund' : r.kind
  if (!isVehicleKind(kind)) return { error: 'Invalid entity kind' }
  let vintageYear: number | null = null
  if (r.vintageYear !== undefined && r.vintageYear !== null && r.vintageYear !== '') {
    const y = Number(r.vintageYear)
    if (!Number.isInteger(y) || y < 1900 || y > 2200) return { error: 'Vintage year must be a year like 2021.' }
    vintageYear = y
  }
  return { name, kind, vintageYear }
}

/**
 * Create the fund's first entity, mirroring POST /api/vehicles: insert the fund_vehicles row, then
 * seed the chart its kind needs with `ensureVehicleAccounts` (a failed seed does not undo the
 * creation; the chart GET seeds on first look). Idempotent by name, so a refresh-and-resubmit of
 * the products step does not 409 — an existing entity of that name is left as it is.
 *
 * The admin client is used because the caller is the fund's sole admin mid-setup and POST
 * /api/vehicles is gated on the accounting domain, which may not be on yet. The caller must have
 * checked the admin role.
 */
export async function createFirstEntity(
  admin: Admin,
  fundId: string,
  entity: FirstEntityInput,
): Promise<{ ok: true; id: string; created: boolean } | { ok: false; error: string }> {
  let existingId: string | null
  try {
    existingId = await vehicleIdByName(admin, fundId, entity.name)
  } catch {
    return { ok: false, error: 'Failed to read entities' }
  }
  if (existingId) return { ok: true, id: existingId, created: false }

  const row: Record<string, unknown> = {
    fund_id: fundId, name: entity.name, kind: entity.kind, aliases: [], active: true,
  }
  if (entity.vintageYear !== null) row.vintage_year = entity.vintageYear
  let res = await (admin as any).from('fund_vehicles').insert(row).select('id').single()
  // vintage_year may not exist until its migration is pushed — same fallback GET /api/vehicles uses.
  if (res.error && 'vintage_year' in row && /vintage_year/.test(res.error.message ?? '')) {
    delete row.vintage_year
    res = await (admin as any).from('fund_vehicles').insert(row).select('id').single()
  }
  if (res.error || !res.data) {
    if (res.error?.code === '23505') return { ok: false, error: 'An entity with that name already exists' }
    console.error('[onboarding] Failed to create first entity:', res.error)
    return { ok: false, error: 'Failed to create the entity' }
  }

  try {
    await ensureVehicleAccounts(admin, fundId, entity.name)
  } catch (e) {
    console.error('[onboarding] Seeding the chart for the first entity failed; it will be seeded on first look:', e)
  }
  return { ok: true, id: res.data.id as string, created: true }
}
