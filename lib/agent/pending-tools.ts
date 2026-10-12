// The approval step, in the conversation: list what is waiting, approve it, or reject it.
//
// A chat assistant's writes are staged (lib/agent/dispatch.ts). These three tools let the person
// who asked for the change confirm it without leaving the chat. They run through the same service
// the app's queue and /api/v1 use (lib/pending-actions/service.ts), so who may see and decide an
// action is answered in one place: the approver's live write access to that action's domain and
// entity, never the stager's.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccessContext } from '@/lib/access/effective'
import type { ResolvedKey } from '@/lib/accounting/api-keys'
import type { AnalystPrincipal } from '@/lib/ai/analyst/types'
import { approvePendingAction, listPendingActions, rejectPendingAction } from '@/lib/pending-actions/service'
import { isAssistantCredential } from './dispatch'

export interface PendingToolContext {
  admin: SupabaseClient
  auth: ResolvedKey
  access: AccessContext
}

export interface PendingTool {
  name: string
  description: string
  scope: 'read' | 'write'
  /** Marks the tool for the MCP endpoint: authorized per action by the service, not by a domain. */
  pendingDecision: true
  inputSchema: Record<string, unknown>
  run: (ctx: PendingToolContext, input: any) => Promise<unknown>
}

function principalOf({ auth, access }: PendingToolContext): AnalystPrincipal {
  return {
    userId: auth.userId, fundId: auth.fundId, role: auth.role, access,
    credentialKind: isAssistantCredential(auth) ? 'oauth' : 'cookie',
  }
}

const ID_SCHEMA = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', description: 'The pendingActionId the staged change returned.' } },
}

function requireId(input: any): string {
  const id = typeof input?.id === 'string' ? input.id.trim() : ''
  if (!id) throw new Error('id (the pendingActionId) is required.')
  return id
}

export const PENDING_TOOLS: PendingTool[] = [
  {
    name: 'list_pending_actions',
    description:
      'Changes waiting for approval: ones staged from this chat or another, and ones the in-app Analyst drafted. ' +
      'Each has an id, a one-line summary and who staged it. Use when the user asks what is waiting, or before approving.',
    scope: 'read',
    pendingDecision: true,
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Max actions (default 20, at most 50)' } } },
    run: async (ctx, input) => {
      const limit = Math.min(Math.max(Number(input?.limit ?? 20) || 20, 1), 50)
      const { actions } = await listPendingActions(ctx.admin, principalOf(ctx), { limit })
      return {
        actions: actions.map(a => ({
          id: a.id, summary: a.preview?.summary, actionType: a.actionType, stagedVia: a.createdVia, createdAt: a.createdAt,
        })),
      }
    },
  },
  {
    name: 'approve_action',
    description:
      'Apply a staged change. ONLY call this after showing the user the change and getting their explicit confirmation ' +
      'in this conversation. Returns the result of the change.',
    scope: 'write',
    pendingDecision: true,
    inputSchema: ID_SCHEMA,
    run: async (ctx, input) => {
      const out = await approvePendingAction(ctx.admin, principalOf(ctx), requireId(input))
      return { applied: true, replayed: out.replayed, summary: out.action.preview?.summary, result: out.result }
    },
  },
  {
    name: 'reject_action',
    description: 'Discard a staged change the user does not want. Nothing it described is applied.',
    scope: 'write',
    pendingDecision: true,
    inputSchema: ID_SCHEMA,
    run: async (ctx, input) => {
      const out = await rejectPendingAction(ctx.admin, principalOf(ctx), requireId(input))
      return { rejected: true, replayed: out.replayed, summary: out.action.preview?.summary }
    },
  },
]

export function getPendingTool(name: unknown): PendingTool | undefined {
  return typeof name === 'string' ? PENDING_TOOLS.find(t => t.name === name) : undefined
}
