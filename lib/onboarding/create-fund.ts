/**
 * Creating a fund: the one path the web wizard, the OAuth consent screen and the bootstrap script
 * all take, so a fund made from chat or a terminal is the same fund the wizard makes.
 *
 * The caller must have authenticated `userId` and checked they belong to no fund yet.
 */
import { randomBytes } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { encrypt } from '@/lib/crypto'
import { AI_PROVIDER_COLUMN, buildFeatureVisibility, claimableEmailDomain, type WizardAIProvider } from './wizard'

export interface AIKeyInput { provider: WizardAIProvider; key: string }

/**
 * A new fund's settings row. Envelope encryption:
 *   1. Generate a random per-fund DEK (data encryption key)
 *   2. Encrypt the DEK with the master KEK from ENCRYPTION_KEY env var
 *   3. Encrypt each credential with the DEK
 */
export function newSettingsRow(
  fundId: string,
  kek: string,
  ai: AIKeyInput | null,
  opts: { agentApiEnabled?: boolean } = {},
): { row: Record<string, unknown>; webhookToken: string } {
  const dek = randomBytes(32).toString('hex')
  // A random webhook token for Postmark URL validation. Stored encrypted only.
  const webhookToken = randomBytes(32).toString('hex')
  const row: Record<string, unknown> = {
    fund_id: fundId,
    encryption_key_encrypted: encrypt(dek, kek),
    postmark_webhook_token_encrypted: encrypt(webhookToken, dek),
    // An explicit, complete map so the stale column DEFAULT never applies. Portfolio tracking only
    // until the products step answers; that step overwrites it.
    feature_visibility: buildFeatureVisibility(['portfolio_reporting']),
  }
  if (ai) {
    row[AI_PROVIDER_COLUMN[ai.provider]] = encrypt(ai.key, dek)
    row.default_ai_provider = ai.provider
  }
  // A fund created FROM an agent (the consent screen, the bootstrap script) is being set up by
  // that agent, so its agent access starts on. The wizard leaves it off, as it always has.
  if (opts.agentApiEnabled) row.agent_api_enabled = true
  return { row, webhookToken }
}

export type CreateFundResult =
  | { ok: true; fundId: string; webhookToken: string }
  | { ok: false; error: string; status: number }

/**
 * Insert the fund (a trigger adds the creator as its admin) and its settings row. A failed settings
 * insert deletes the fund again, so a half-made fund never lingers.
 */
export async function createFund(
  admin: SupabaseClient,
  args: { userId: string; email: string | null | undefined; fundName: string; ai?: AIKeyInput | null; agentApiEnabled?: boolean },
): Promise<CreateFundResult> {
  const fundName = args.fundName.trim()
  if (!fundName) return { ok: false, error: 'Fund name is required', status: 400 }
  if (fundName.length > 200) return { ok: false, error: 'Fund name is too long', status: 400 }
  const kek = process.env.ENCRYPTION_KEY
  if (!kek) return { ok: false, error: 'Server misconfiguration: ENCRYPTION_KEY not set', status: 500 }

  // The creator's email domain, for "Request to join" matching — never a consumer mailbox domain.
  const { data: fund, error: fundError } = await (admin as any)
    .from('funds')
    .insert({ name: fundName, created_by: args.userId, email_domain: claimableEmailDomain(args.email) })
    .select('id')
    .single()
  if (fundError || !fund) {
    console.error('[create-fund] Failed to create fund:', fundError)
    return { ok: false, error: 'Failed to create fund', status: 500 }
  }

  const { row, webhookToken } = newSettingsRow(fund.id, kek, args.ai ?? null, { agentApiEnabled: args.agentApiEnabled })
  const { error: settingsError } = await (admin as any).from('fund_settings').insert(row)
  if (settingsError) {
    console.error('[create-fund] Failed to create fund_settings:', settingsError)
    await (admin as any).from('funds').delete().eq('id', fund.id)
    return { ok: false, error: 'Failed to save settings', status: 500 }
  }
  return { ok: true, fundId: fund.id as string, webhookToken }
}

/**
 * May this signed-in person create a fund from an agent (the OAuth consent screen)? Not if they
 * already belong to one (one fund per user), and not if they are an LP: an LP account is on the
 * signup allow-list only because a fund invited them to its portal, which is no licence to start
 * a fund of their own.
 */
export async function fundCreationRefusal(admin: SupabaseClient, userId: string): Promise<string | null> {
  const db = admin as any
  const [{ data: membership }, { data: lp }] = await Promise.all([
    db.from('fund_members').select('fund_id').eq('user_id', userId).maybeSingle(),
    db.from('lp_accounts').select('id').eq('auth_user_id', userId).maybeSingle(),
  ])
  if (membership) return 'You already belong to a fund.'
  if (lp) return 'This is an investor portal account. Sign in with your fund team account to set up a fund.'
  return null
}
