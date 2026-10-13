// One path for every agent tool call, whichever door it came through (MCP or the REST agent API).
//
// Before this, both routes called `tool.handler` themselves, so a write from Claude reached the
// books with nothing around it: no audit event (the web journal route records `entry.post`; the
// MCP `post_entry` did not), no record of which credential or channel made it, no protection
// against a host retrying a timed-out call, and no chance for a person to look before it landed.
// This module is where all four live, so a tool added to the registry gets them without asking.
//
//   1. Idempotency. A write may carry a key; a retry under it replays the first result instead of
//      writing twice (the /api/v1 store, lib/api-v1/idempotency.ts). A chat assistant's write that
//      would be staged and carries NO key gets one derived from what it asks (see
//      `assistantDedupeKey`), so the same change asked twice — a retry, or two chats — is staged once.
//   2. Staging. A chat assistant's write (an OAuth credential) is staged as a pending action and
//      applied only when a person approves it. An API key — a script someone wrote on purpose —
//      writes directly, as before. Calls that only make drafts or previews always run directly:
//      a draft is already a proposal someone has to post.
//   3. Audit. Every write that runs, and every one that is staged, leaves an append-only
//      `accounting_audit_events` row naming the person, the source (mcp or api) and the credential.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccessContext } from '@/lib/access/effective'
import type { ResolvedKey } from '@/lib/accounting/api-keys'
import {
  accessDomainForCall, accessFeatureFor, isLedgerTool, resolveVehicleForTool, type AgentTool,
} from '@/lib/accounting/agent-tools'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { recordAudit } from '@/lib/audit/events'
import type { ChangeSource } from '@/lib/audit/source'
import {
  canonicalJson, claimIdempotentRequest, completeIdempotentRequest, releaseIdempotentRequest, requestFingerprint,
  IDEMPOTENCY_MAX_KEY_LENGTH, type IdempotencyOutcome, type IdempotencyScope,
} from '@/lib/api-v1/idempotency'
import { AGENT_TOOL_CALL, stageToolCall } from './tool-call-action'
import { notifyAdminsOfStagedChange } from '@/lib/pending-actions/notify'
import { adminOnlyMessage, adminOnlyToolLabel } from '@/lib/access/admin-only'

/** Which door a call came through. Recorded on every write, as `source` (lib/audit/source.ts). */
export type AgentChannel = Extract<ChangeSource, 'mcp' | 'api'>

export interface AgentCall {
  admin: SupabaseClient
  tool: AgentTool
  input: Record<string, unknown>
  auth: ResolvedKey
  access: AccessContext
  channel: AgentChannel
  origin?: string
  /** Optional, writes only. A retry with the same key and input returns the first result. */
  idempotencyKey?: string | null
}

/** What a staged write returns in place of the tool's own result. */
export interface StagedResult {
  staged: true
  pendingActionId: string
  summary: string
  preview: Record<string, unknown>
  /** The app's approvals page, when the request's origin is known. */
  approveUrl?: string
  next: string
}

/** OAuth credentials are a chat assistant acting for someone; static keys are scripts. */
export function isAssistantCredential(auth: Pick<ResolvedKey, 'keyId'>): boolean {
  return auth.keyId.startsWith('oauth:')
}

/**
 * Calls that only create drafts or previews. They change nothing anyone relies on until a
 * person posts the draft, and posting is itself a write that stages, so staging these too would
 * only make the assistant ask twice.
 */
const DRAFT_ONLY: Record<string, (input: Record<string, unknown>) => boolean> = {
  post_entry: input => input.status === 'draft',
  post_ledger_text: input => input.status === 'draft',
  allocation: input => input.post === false,
  // Stage a feed as drafts and re-point those drafts; posting them is post_bank_transaction / post_drafts.
  import_bank_transactions: () => true,
  // An outside ledger lands as drafts too (lib/accounting/quickbooks/import-journal.ts); a mapping
  // change is not a draft and still stages.
  import_journal: () => true,
  categorize_bank_transactions: () => true,
  set_bank_transaction_account: () => true,
  // Filling a saved template makes a draft document for the person to read before sending; it
  // changes nothing else. Saving the template itself still stages.
  document_generate: () => true,
}

export function isDraftOnlyCall(tool: Pick<AgentTool, 'name'>, input: Record<string, unknown>): boolean {
  return DRAFT_ONLY[tool.name]?.(input) ?? false
}

/** Whether some calls of this tool are draft-only (search_tools says so beside "staged"). */
export function hasDraftMode(name: string): boolean {
  return name in DRAFT_ONLY
}

/** Whether this write waits for a person. Reads never do. */
export function shouldStage(tool: AgentTool, input: Record<string, unknown>, auth: Pick<ResolvedKey, 'keyId'>): boolean {
  return tool.scope === 'write' && isAssistantCredential(auth) && !isDraftOnlyCall(tool, input)
}

/**
 * An admin-only operation (lib/access/admin-only.ts) from someone who is not an admin. From chat
 * it is still staged, so they can propose it and an admin decides; from a key it is refused, since
 * a key has no one to ask.
 */
function adminOnlyRefusal(tool: AgentTool, input: Record<string, unknown>, auth: Pick<ResolvedKey, 'keyId' | 'role'>): string | null {
  const label = adminOnlyToolLabel(tool.name, input)
  if (!label || auth.role === 'admin' || isAssistantCredential(auth)) return null
  return adminOnlyMessage(label)
}

/** A key the caller sent, or null when it is absent or unusable. */
export function idempotencyKeyOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const key = raw.trim()
  return key && key.length <= IDEMPOTENCY_MAX_KEY_LENGTH ? key : null
}

/**
 * The input as the audit trail keeps it: whole when small, otherwise its size. A bank CSV or a
 * ledger text can run to megabytes, and the trail is read by a person, not replayed.
 */
const AUDIT_INPUT_LIMIT = 20_000
export function auditInput(input: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(input)
  return json.length <= AUDIT_INPUT_LIMIT ? input : { truncated: true, bytes: json.length }
}

/** The ids a result names, so the trail can point at what changed without copying the payload. */
function resultRefs(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== 'object') return {}
  const refs: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
    if ((/Id$|^id$/.test(k) && (typeof v === 'string' || typeof v === 'number')) || ((k === 'posted' || k === 'imported') && typeof v === 'number')) {
      refs[k] = v
    }
  }
  return refs
}

/**
 * How long an assistant's identical write is treated as the same request. Long enough to cover a
 * second chat opened the same day on the same task (which is how a carry reallocation was booked
 * twice); short enough that the same routine entry next week is a new request.
 */
export const ASSISTANT_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000
/** The derived keys' client: every OAuth client of one person shares it, so a second host is caught too. */
const ASSISTANT_DEDUPE_CLIENT = 'assistant:derived'

/**
 * The key an assistant's write is deduplicated under when it sent none, or null when it is not
 * deduplicated. Only writes that will be STAGED: replaying the first pending action for an
 * identical request is always right, because staging changes nothing and the replay names the same
 * action to approve. Draft-only calls (DRAFT_ONLY) run directly and are left alone — their result
 * depends on the books at the time (a categorization re-run, a bank row pointed back to its first
 * account, a regenerated document, a ledger text re-sent after its unknown account was added), so
 * replaying a stale result would be wrong, and a duplicate draft still has to be posted through a
 * call that stages. Per person (the key names them), across every assistant host they use.
 */
export async function assistantDedupeKey(call: AgentCall): Promise<{ key: string; fingerprint: string; scope: IdempotencyScope } | null> {
  const { admin, tool, input, auth, access } = call
  if (!shouldStage(tool, input, auth)) return null
  // The entity as it will be staged, so "vehicle omitted" and "vehicle named" are the same request.
  const vehicle = await resolveVehicleForTool(tool, admin, auth.fundId, input.vehicle as string | undefined, access)
  const rest = vehicle ? Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'vehicle')) : input
  const fingerprint = requestFingerprint({ canonical: canonicalJson({ tool: tool.name, vehicle: vehicle || null, input: rest }) })
  return {
    key: `derived:${auth.userId ?? 'anyone'}:${fingerprint}`,
    fingerprint,
    scope: { fundId: auth.fundId, clientId: ASSISTANT_DEDUPE_CLIENT, userId: auth.userId },
  }
}

/** A staged action's current status, or null when the result is not a staged one or cannot be read. */
async function stagedStatus(admin: SupabaseClient, fundId: string, result: unknown): Promise<string | null> {
  const id = (result as Partial<StagedResult> | null)?.pendingActionId
  if (!(result as Partial<StagedResult> | null)?.staged || typeof id !== 'string') return null
  const { data, error } = await (admin as any).from('pending_actions').select('status').eq('id', id).eq('fund_id', fundId).maybeSingle()
  return error ? null : ((data as { status?: string } | null)?.status ?? null)
}

/** What a repeat of an already-staged request returns: the first action, and what to do about it. */
function repeatOfStaged(prior: StagedResult, status: string | null): StagedResult & { duplicate: true; status: string | null } {
  const id = prior.pendingActionId
  const done = status === 'approved' || status === 'applied'
  return {
    ...prior,
    duplicate: true,
    status,
    next: done
      ? `Nothing was staged: this exact change was already requested (pending action "${id}") and has been ${status} — possibly from another chat. ` +
        'Do NOT approve or send it again; tell the user it is already done. Only if the user explicitly confirms they want the same change ' +
        'made a SECOND time, call the tool again with _meta.idempotencyKey (or the Idempotency-Key header) set to a new unique value.'
      // The first staging's own instructions still apply (they differ for an admin-only change).
      : `Nothing new was staged: this exact change is already waiting for approval as pending action "${id}" — possibly from another chat; ` +
        'approve it once, not once per request. ' + prior.next + ' ' +
        'Only if the user explicitly wants the same change made twice, call the tool again with _meta.idempotencyKey set to a new unique value.',
  }
}

export class AgentCallError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
  }
}

/**
 * Run one authorized tool call. The caller has already checked the credential and the owner's
 * grants for this call (authorizeToolUse / authorizeMcpTool); this adds what every write needs.
 */
export async function runAgentTool(call: AgentCall): Promise<unknown> {
  const { admin, tool, input, auth, access, origin } = call
  if (tool.scope === 'read') {
    const portfolioGroup = await resolveVehicleForTool(tool, admin, auth.fundId, input.vehicle as string | undefined, access)
    return tool.handler({ admin, fundId: auth.fundId, portfolioGroup, userId: auth.userId, access, origin }, input)
  }

  const refusal = adminOnlyRefusal(tool, input, auth)
  if (refusal) throw new AgentCallError(refusal, 'ADMIN_ONLY')

  // An explicit key always wins; without one, an assistant's staged write gets a derived one.
  const derived = call.idempotencyKey ? null : await assistantDedupeKey(call)
  const scope: IdempotencyScope = derived?.scope ?? { fundId: auth.fundId, clientId: auth.keyId, userId: auth.userId }
  const key = call.idempotencyKey ?? derived?.key ?? null
  const endpoint = `agent:${tool.name}`
  if (key) {
    const claim = (): Promise<IdempotencyOutcome> => claimIdempotentRequest(admin, scope, derived
      ? { endpoint, key, fingerprint: derived.fingerprint, windowMs: ASSISTANT_DEDUPE_WINDOW_MS }
      : { endpoint, key, fingerprint: requestFingerprint({ tool: tool.name, input }) })
    let outcome = await claim()
    if (derived && outcome.kind === 'replay') {
      const prior = (outcome.body as { result?: unknown }).result ?? null
      const status = await stagedStatus(admin, auth.fundId, prior)
      // Declined, or tried and failed: nothing was applied, so asking again is a new request.
      if (status === 'rejected' || status === 'failed') {
        await releaseIdempotentRequest(admin, scope, { endpoint, key })
        outcome = await claim()
      } else if (prior && (prior as StagedResult).staged) {
        return repeatOfStaged(prior as StagedResult, status)
      }
    }
    if (outcome.kind === 'replay') return (outcome.body as { result?: unknown }).result ?? null
    if (outcome.kind === 'conflict') throw new AgentCallError(outcome.message, outcome.code)
  }

  try {
    const result = shouldStage(tool, input, auth) ? await stage(call) : await apply(call)
    if (key) await completeIdempotentRequest(admin, scope, { endpoint, key, status: 200, body: { result: result as any } })
    return result
  } catch (e) {
    if (key) await releaseIdempotentRequest(admin, scope, { endpoint, key })
    throw e
  }
}

/** Run the write now, as its owner, and record it. */
async function apply(call: AgentCall): Promise<unknown> {
  const { admin, tool, input, auth, access, origin, channel } = call
  const portfolioGroup = await resolveVehicleForTool(tool, admin, auth.fundId, input.vehicle as string | undefined, access)
  const result = await tool.handler({ admin, fundId: auth.fundId, portfolioGroup, userId: auth.userId, access, origin }, input)
  const vehicleId = isLedgerTool(tool) && portfolioGroup ? await vehicleIdByName(admin, auth.fundId, portfolioGroup) : null
  await recordAudit(admin, {
    fundId: auth.fundId, vehicleId, actorId: auth.userId, action: 'agent.write',
    subjectType: 'agent_tool', subjectId: tool.name, source: channel,
    details: {
      tool: tool.name, credentialId: auth.keyId,
      domain: accessDomainForCall(tool, input), feature: accessFeatureFor(tool) ?? null,
      input: auditInput(input), result: resultRefs(result),
    },
  })
  return result
}

/** Stage the write as a pending action for a person to approve. Nothing else changes. */
async function stage(call: AgentCall): Promise<StagedResult> {
  const { admin, tool, input, auth, access, channel, origin } = call
  const deps = { admin, fundId: auth.fundId, userId: auth.userId, access }
  const { args, vehicleId, preview } = await stageToolCall(deps, tool.name, input)
  const { data, error } = await (admin as any)
    .from('pending_actions')
    .insert({
      fund_id: auth.fundId,
      domain: accessDomainForCall(tool, input),
      action_type: AGENT_TOOL_CALL,
      args,
      vehicle_id: vehicleId,
      preview,
      status: 'pending',
      created_by: auth.userId,
      created_via: channel,
    })
    .select('id')
    .single()
  if (error) throw new Error(error.message)
  const id = (data as { id: string }).id
  await recordAudit(admin, {
    fundId: auth.fundId, vehicleId, actorId: auth.userId, action: 'pending_action.stage',
    subjectType: 'pending_action', subjectId: id, source: channel,
    details: { actionType: AGENT_TOOL_CALL, args: { tool: tool.name, input: auditInput(args.input) }, credentialId: auth.keyId },
  })
  // An admin-only change from a member waits on someone outside this conversation: tell them.
  const adminLabel = adminOnlyToolLabel(tool.name, input)
  const emailed = adminLabel && auth.role !== 'admin'
    ? await notifyAdminsOfStagedChange(admin, { fundId: auth.fundId, label: adminLabel, summary: preview.summary, requesterId: auth.userId, origin })
    : 0
  // A chat whose tool list predates the approval tools (hosts cache it per conversation) is told to
  // call one it does not have, so the result also carries the page where a person can approve.
  const approveUrl = origin ? `${origin}/pending-actions` : undefined
  const inApp = approveUrl ? `in the app at ${approveUrl}` : 'in the app, under Approvals'
  return {
    staged: true,
    pendingActionId: id,
    summary: preview.summary,
    preview: preview.details,
    ...(approveUrl ? { approveUrl } : {}),
    next: adminLabel && auth.role !== 'admin'
      ? `Nothing has changed yet. ${adminOnlyMessage(adminLabel)}${emailed ? " The fund's admins have been emailed." : ''} ` +
        'Tell the user it is waiting for an admin, who can approve it from their own chat ' +
        '(list_pending_actions, then approve_action) or through the API, without opening the app.'
      : 'Nothing has changed yet. Show the user this change in plain words and ask them to confirm. ' +
      `Only after they confirm, call approve_action with id "${id}"; if they decline, call reject_action. ` +
      'Approving here is the normal path; the app is not needed. ' +
      'If approve_action is not in your tool list (a stale list), run it through call_tool. ' +
      `Only if you have neither, tell the user to reconnect, or approve it ${inApp}.`,
  }
}
