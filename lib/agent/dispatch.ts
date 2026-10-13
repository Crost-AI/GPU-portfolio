// One path for every agent tool call, whichever door it came through (MCP or the REST agent API).
//
// Before this, both routes called `tool.handler` themselves, so a write from Claude reached the
// books with nothing around it: no audit event (the web journal route records `entry.post`; the
// MCP `post_entry` did not), no record of which credential or channel made it, no protection
// against a host retrying a timed-out call, and no chance for a person to look before it landed.
// This module is where all four live, so a tool added to the registry gets them without asking.
//
//   1. Idempotency. A write may carry a key; a retry under it replays the first result instead of
//      writing twice (the /api/v1 store, lib/api-v1/idempotency.ts).
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
  accessDomainForCall, accessFeatureFor, getTool, isLedgerTool, resolveVehicleForTool, type AgentTool,
} from '@/lib/accounting/agent-tools'
import { authorizeToolUse } from '@/lib/accounting/api-keys'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { recordAudit } from '@/lib/audit/events'
import type { ChangeSource } from '@/lib/audit/source'
import {
  claimIdempotentRequest, completeIdempotentRequest, releaseIdempotentRequest, requestFingerprint,
  IDEMPOTENCY_MAX_KEY_LENGTH, type IdempotencyScope,
} from '@/lib/api-v1/idempotency'
import { AGENT_TOOL_CALL, stageToolCall } from './tool-call-action'
import { AGENT_RUN, runAdminOnlyLabel, stageRun, type RunArgs } from './run-action'
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

/** Whether this write waits for a person. Reads never do. */
export function shouldStage(tool: AgentTool, input: Record<string, unknown>, auth: Pick<ResolvedKey, 'keyId'>): boolean {
  return tool.scope === 'write' && isAssistantCredential(auth) && !isDraftOnlyCall(tool, input)
}

/**
 * An admin-only operation (lib/access/admin-only.ts) from someone who is not an admin. From chat
 * it is still staged, so they can propose it and an admin decides; from a key it is refused, since
 * a key has no one to ask.
 */
export function adminOnlyRefusal(tool: AgentTool, input: Record<string, unknown>, auth: Pick<ResolvedKey, 'keyId' | 'role'>): string | null {
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

  const scope: IdempotencyScope = { fundId: auth.fundId, clientId: auth.keyId, userId: auth.userId }
  const key = call.idempotencyKey ?? null
  const endpoint = `agent:${tool.name}`
  if (key) {
    const outcome = await claimIdempotentRequest(admin, scope, {
      endpoint, key, fingerprint: requestFingerprint({ tool: tool.name, input }),
    })
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

/**
 * Insert a pending_actions row, naming the credential that staged it. Until migration
 * 20261013143000 is pushed the column is missing (Postgres' undefined column); the row is then
 * written without it and the service falls back to its channel, so the deploy and the push may
 * land in either order.
 */
async function insertStaged(admin: SupabaseClient, row: Record<string, unknown>, credentialId: string): Promise<string> {
  const insert = (r: Record<string, unknown>) => (admin as any).from('pending_actions').insert(r).select('id').single()
  let { data, error } = await insert({ ...row, created_credential: credentialId })
  if (error?.code === '42703') ({ data, error } = await insert(row))
  if (error) throw new Error(error.message)
  return (data as { id: string }).id
}

/** The app's approvals page, when the request's origin is known. */
function approveUrlFor(origin: string | undefined): string | undefined {
  return origin ? `${origin}/pending-actions` : undefined
}

/**
 * What the assistant is told to do with a staged change. It cannot approve it itself (the service
 * refuses an approval from the credential that staged it), so it hands the person the link.
 */
function nextStep(opts: { id: string; approveUrl?: string; adminLabel?: string | null; emailed: number; isAdmin: boolean }): string {
  const inApp = opts.approveUrl ? `in the app at ${opts.approveUrl}` : 'in the app, under Approvals'
  if (opts.adminLabel && !opts.isAdmin) {
    return `Nothing has changed yet. ${adminOnlyMessage(opts.adminLabel)}${opts.emailed ? " The fund's admins have been emailed." : ''} ` +
      `Tell the user it is waiting for an admin, who approves it ${inApp}.`
  }
  return 'Nothing has changed yet. Show the user this change in plain words, then give them the link to approve it ' +
    `${inApp}. This connection cannot approve its own changes: approve_action on id "${opts.id}" from here is refused. ` +
    'If they decline, call reject_action. When a fix needs several changes, stage them together with stage_run so they are approved once.'
}

/** Stage the write as a pending action for a person to approve. Nothing else changes. */
async function stage(call: AgentCall): Promise<StagedResult> {
  const { admin, tool, input, auth, access, channel, origin } = call
  const deps = { admin, fundId: auth.fundId, userId: auth.userId, access }
  const { args, vehicleId, preview } = await stageToolCall(deps, tool.name, input)
  const id = await insertStaged(admin, {
    fund_id: auth.fundId,
    domain: accessDomainForCall(tool, input),
    action_type: AGENT_TOOL_CALL,
    args,
    vehicle_id: vehicleId,
    preview,
    status: 'pending',
    created_by: auth.userId,
    created_via: channel,
  }, auth.keyId)
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
  const approveUrl = approveUrlFor(origin)
  return {
    staged: true,
    pendingActionId: id,
    summary: preview.summary,
    preview: preview.details,
    ...(approveUrl ? { approveUrl } : {}),
    next: nextStep({ id, approveUrl, adminLabel, emailed, isAdmin: auth.role === 'admin' }),
  }
}

export interface RunCall {
  admin: SupabaseClient
  auth: ResolvedKey
  access: AccessContext
  channel: AgentChannel
  origin?: string
}

/**
 * Stage a whole run as ONE pending action (lib/agent/run-action.ts). Every step is checked the way
 * the same call made directly would be — the credential's scope and the owner's grant for that
 * call's domain, admin-only rules for a key — before anything is written. Always staged, whatever
 * the credential: a run exists to be looked at once by a person.
 */
export async function stageAgentRun(call: RunCall, input: unknown): Promise<StagedResult & { steps: number }> {
  const { admin, auth, access, channel, origin } = call
  const deps = { admin, fundId: auth.fundId, userId: auth.userId, access }
  const { args, vehicleId, preview } = await stageRun(deps, input, (name, stepInput) => {
    const tool = getTool(name)!
    return authorizeToolUse(tool.scope, auth, access, accessDomainForCall(tool, stepInput), accessFeatureFor(tool))
      ?? adminOnlyRefusal(tool, stepInput, auth)
  })
  const first = getTool(args.steps[0].tool)!
  const id = await insertStaged(admin, {
    fund_id: auth.fundId,
    // The column holds one domain; the service gates a run on every step's (lib/pending-actions/staged.ts).
    domain: accessDomainForCall(first, args.steps[0].input),
    action_type: AGENT_RUN,
    args,
    vehicle_id: vehicleId,
    preview,
    status: 'pending',
    created_by: auth.userId,
    created_via: channel,
  }, auth.keyId)
  await recordAudit(admin, {
    fundId: auth.fundId, vehicleId, actorId: auth.userId, action: 'pending_action.stage',
    subjectType: 'pending_action', subjectId: id, source: channel,
    details: { actionType: AGENT_RUN, args: auditRunArgs(args), credentialId: auth.keyId },
  })
  const adminLabel = runAdminOnlyLabel(args)
  const emailed = adminLabel && auth.role !== 'admin'
    ? await notifyAdminsOfStagedChange(admin, { fundId: auth.fundId, label: adminLabel, summary: preview.summary, requesterId: auth.userId, origin })
    : 0
  const approveUrl = approveUrlFor(origin)
  return {
    staged: true,
    pendingActionId: id,
    steps: args.steps.length,
    summary: preview.summary,
    preview: preview.details,
    ...(approveUrl ? { approveUrl } : {}),
    next: nextStep({ id, approveUrl, adminLabel, emailed, isAdmin: auth.role === 'admin' }),
  }
}

/** A run's args as the trail keeps them: each step's input whole when small. */
function auditRunArgs(args: RunArgs): Record<string, unknown> {
  return { ...args, steps: args.steps.map(s => ({ tool: s.tool, input: auditInput(s.input) })) }
}
