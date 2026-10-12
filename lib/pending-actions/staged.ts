// Every action type a pending_actions row may hold, and the gate each row answers to.
//
// Two families share the table: the Analyst's drafts (WRITE_ACTIONS, one fixed domain each) and an
// external assistant's staged tool calls (lib/agent/tool-call-action.ts), whose domain is the
// staged tool's. Deciding, listing and reading the audit trail all go through `stagedAction`, so
// both families are gated the same way. The Analyst's drafting menu still reads WRITE_ACTIONS
// directly and never sees the tool-call type.

import type { Domain } from '@/lib/access/domains'
import type { FeatureKey } from '@/lib/types/features'
import { getWriteAction } from './registry'
import { ADMIN_ONLY_ACTIONS, adminOnlyToolLabel } from '@/lib/access/admin-only'
import type { ActionDeps, PreviewResult } from './types'
import {
  AGENT_TOOL_CALL, executeToolCall, previewToolCall, toolCallGate,
} from '@/lib/agent/tool-call-action'

export interface StagedAction {
  domain: Domain
  accessFeature?: FeatureKey
  /** As WriteAction.entity: whether a row with no vehicle is about everyone's data. */
  entity: 'required' | 'optional' | 'none'
  /** Set when only an admin may approve it (lib/access/admin-only.ts): what it does, for the refusal. */
  adminOnly?: string
  preview: (deps: ActionDeps, input: any) => Promise<PreviewResult>
  execute: (deps: ActionDeps, input: any) => Promise<Record<string, unknown>>
}

/** The action a row holds, gated for ITS args; undefined when nothing says who may see it. */
export function stagedAction(actionType: string, args: unknown): StagedAction | undefined {
  if (actionType === AGENT_TOOL_CALL) {
    const gate = toolCallGate(args)
    if (!gate) return undefined
    const a = args as { tool?: string; input?: unknown }
    return {
      ...gate, entity: 'optional', preview: previewToolCall, execute: executeToolCall,
      adminOnly: adminOnlyToolLabel(String(a.tool), a.input),
    }
  }
  const action = getWriteAction(actionType)
  return action && { ...action, adminOnly: ADMIN_ONLY_ACTIONS[actionType] }
}
