// A connected assistant's write, staged for a person to approve.
//
// The Analyst drafts only the handful of writes in lib/pending-actions/registry.ts, each with its
// own hand-written preview. An external assistant (Claude, ChatGPT over OAuth) can call EVERY write
// tool in the agent registry, so its staging can't be per-action: one action type,
// `agent_tool_call`, stores the tool's name and input, and approval runs that tool exactly as a
// direct call would have — through its own handler, re-authorized against the APPROVER's live
// access, never the stager's.
//
// Deliberately NOT in WRITE_ACTIONS. That map is the Analyst's drafting menu, and anything in it is
// offered to the in-app model as a tool. A generic "run any write tool" entry there would hand the
// Analyst every write in the registry behind a read grant. Only lib/pending-actions/staged.ts knows
// about this action.

import { describeSetupPlan, parseSetupPlan } from '@/lib/onboarding/setup-plan'
import type { Domain } from '@/lib/access/domains'
import { hasAccess } from '@/lib/access/effective'
import type { FeatureKey } from '@/lib/types/features'
import {
  accessDomainForCall, accessFeatureFor, getTool, isLedgerTool, resolveVehicleForTool,
  type AgentTool,
} from '@/lib/accounting/agent-tools'
import { resolveVehicleWithAccess } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import type { ActionDeps, PreviewResult } from '@/lib/pending-actions/types'

export const AGENT_TOOL_CALL = 'agent_tool_call'

/** What a staged tool call stores in pending_actions.args. */
export interface ToolCallArgs {
  tool: string
  input: Record<string, unknown>
}

export function toolCallArgs(raw: unknown): ToolCallArgs | null {
  const a = raw as Partial<ToolCallArgs> | null
  if (!a || typeof a.tool !== 'string') return null
  return { tool: a.tool, input: a.input && typeof a.input === 'object' ? a.input as Record<string, unknown> : {} }
}

/**
 * Who may see and decide a staged call: the domain the CALL touches (an `allocation` with
 * action 'carry' is GP economics, not accounting) and the tool's feature switch. Undefined for a
 * tool the registry no longer has, which hides the row rather than guessing its gate.
 */
export function toolCallGate(raw: unknown): { domain: Domain; accessFeature?: FeatureKey } | undefined {
  const args = toolCallArgs(raw)
  const tool = args ? getTool(args.tool) : undefined
  if (!args || !tool || tool.scope !== 'write') return undefined
  return { domain: accessDomainForCall(tool, args.input), accessFeature: accessFeatureFor(tool) }
}

function requireTool(raw: unknown): { tool: AgentTool; args: ToolCallArgs } {
  const args = toolCallArgs(raw)
  const tool = args ? getTool(args.tool) : undefined
  if (!args || !tool || tool.scope !== 'write') throw new Error('Unknown tool in staged call.')
  return { tool, args }
}

/**
 * The entity the call acts on, resolved with the caller's access. Throws when it is outside it.
 *
 * Ledger tools run against exactly one vehicle, resolved the way a direct call resolves it. Other
 * tools take `vehicle` as an optional input; a named one must be visible, and an unnamed one is
 * visible only to a caller who sees every entity, since nothing else says whose data it is.
 */
async function resolveEntity(deps: ActionDeps, tool: AgentTool, input: Record<string, unknown>): Promise<string | null> {
  const requested = typeof input.vehicle === 'string' && input.vehicle.trim() ? input.vehicle : undefined
  if (isLedgerTool(tool)) return resolveVehicleForTool(tool, deps.admin, deps.fundId, requested, deps.access)
  if (requested) return (await resolveVehicleWithAccess(deps.admin, deps.access, requested, 'read')).name
  if (!deps.access.vehicles?.all) throw new Error('This staged change is not about one of your entities.')
  return null
}

/** A short, readable line for the approver: the tool, the entity, and the inputs that matter. */
export function summarizeToolCall(tool: string, input: Record<string, unknown>, vehicle: string | null): string {
  const shown = Object.entries(input)
    .filter(([k, v]) => k !== 'vehicle' && v !== undefined && v !== null && typeof v !== 'object')
    .slice(0, 4)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`)
  const where = vehicle ? ` on ${vehicle}` : ''
  return `${tool}${where}${shown.length ? ` (${shown.join(', ')})` : ''}`
}

/** Pin the entity with the stager's access, as stagedTarget does for the Analyst's actions. */
export async function stageToolCall(deps: ActionDeps, toolName: string, input: Record<string, unknown>) {
  const { tool } = requireTool({ tool: toolName, input })
  const vehicle = await resolveEntity(deps, tool, input)
  const pinned = vehicle ? { ...input, vehicle } : input
  const vehicleId = vehicle ? await vehicleIdByName(deps.admin, deps.fundId, vehicle) : null
  const args: ToolCallArgs = { tool: toolName, input: pinned }
  return { args, vehicleId, preview: await previewToolCall(deps, args) }
}

export async function previewToolCall(deps: ActionDeps, raw: unknown): Promise<PreviewResult> {
  const { tool, args } = requireTool(raw)
  const vehicle = await resolveEntity(deps, tool, args.input)
  // A setup plan is many changes in one call; the person approving it should see each of them.
  if (tool.name === 'setup_fund') {
    const plan = parseSetupPlan(args.input)
    const lines = 'error' in plan ? [plan.error] : describeSetupPlan(plan)
    return { summary: `Set up the fund: ${lines.join('; ')}`, details: { tool: tool.name, vehicle: null, plan: lines, input: args.input } }
  }
  return {
    summary: summarizeToolCall(tool.name, args.input, vehicle),
    details: { tool: tool.name, vehicle, input: args.input },
  }
}

/**
 * Run the staged call as the approver. The service has already checked the approver's write
 * access for the call's domain; the vehicle is re-resolved with their access, so an approver who
 * cannot see the entity cannot apply it.
 */
export async function executeToolCall(deps: ActionDeps, raw: unknown): Promise<Record<string, unknown>> {
  const { tool, args } = requireTool(raw)
  if (!hasAccess(deps.access, accessDomainForCall(tool, args.input), 'write', accessFeatureFor(tool))) {
    throw new Error('You do not have current write access for this change.')
  }
  const requested = typeof args.input.vehicle === 'string' ? args.input.vehicle : undefined
  const portfolioGroup = await resolveVehicleForTool(tool, deps.admin, deps.fundId, requested, deps.access)
  const result = await tool.handler(
    { admin: deps.admin, fundId: deps.fundId, portfolioGroup, userId: deps.userId, access: deps.access },
    args.input,
  )
  return { tool: tool.name, result: result ?? null }
}
