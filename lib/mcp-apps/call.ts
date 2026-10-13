// One `tools/call`, whichever way it was named: directly, or through `call_tool` (./gateway.ts).
// Lives here rather than in the route so both are provably the same path, and so the tests can
// see that they are.

import type { AccessContext } from '@/lib/access/effective'
import type { ResolvedKey } from '@/lib/accounting/api-keys'
import { getTool, resolveVehicleForTool, type AgentToolContext } from '@/lib/accounting/agent-tools'
import { idempotencyKeyOf, runAgentTool } from '@/lib/agent/dispatch'
import { CALL_TOOL, closeMatches, isGatewayTool, searchTools, SEARCH_TOOLS } from './gateway'
import { authorizeMcpTool, getMcpTool, isPendingTool, toolResult } from './server'

export type McpCallContext = Omit<AgentToolContext, 'portfolioGroup'>

export interface McpCall {
  name: unknown
  args: Record<string, unknown>
  /** The request's `params._meta`: carries `idempotencyKey` for a write. */
  meta?: Record<string, unknown>
  ctx: McpCallContext
  auth: ResolvedKey
  access: AccessContext
}

/** A tool result, or a JSON-RPC error for a call naming no tool at all. */
export type McpCallOutcome = { result: unknown } | { error: { code: number; message: string } }

const refusal = (text: string) => ({ result: { content: [{ type: 'text', text }], isError: true } })

export async function callMcpTool(call: McpCall): Promise<McpCallOutcome> {
  const { name, args, meta, ctx, auth, access } = call
  if (name === SEARCH_TOOLS) return { result: { content: [{ type: 'text', text: JSON.stringify(searchTools(args, auth, access)) }] } }
  if (name === CALL_TOOL) return callThroughGateway(call)

  const tool = getMcpTool(name)
  if (!tool) return { error: { code: -32602, message: `Unknown tool: ${name}` } }
  const denied = authorizeMcpTool(tool, auth, access, args)
  if (denied) return refusal(denied)
  try {
    // Approval tools: authorized per action by the pending-actions service.
    if (isPendingTool(tool)) return { result: toolResult(tool, await tool.run({ admin: ctx.admin, auth, access }, args)) }
    // The shared registry goes through the one dispatcher, which stages, audits and dedupes
    // writes (lib/agent/dispatch.ts). A retry may name its call with _meta.idempotencyKey.
    const agentTool = getTool(tool.name)
    if (agentTool) {
      const result = await runAgentTool({
        admin: ctx.admin, tool: agentTool, input: args, auth, access, channel: 'mcp', origin: ctx.origin,
        idempotencyKey: idempotencyKeyOf(meta?.idempotencyKey),
      })
      return { result: toolResult(tool, result) }
    }
    const portfolioGroup = await resolveVehicleForTool(tool, ctx.admin, ctx.fundId, args.vehicle as string | undefined, access)
    return { result: toolResult(tool, await tool.handler({ ...ctx, portfolioGroup }, args)) }
  } catch (e) {
    return refusal((e as Error).message)
  }
}

/**
 * `call_tool { name, arguments }`: the named tool, through the path above with nothing skipped.
 * The request's `_meta` passes through, so an idempotency key still dedupes the write.
 */
async function callThroughGateway(call: McpCall): Promise<McpCallOutcome> {
  const target = call.args?.name
  if (typeof target !== 'string' || !target) return refusal('call_tool needs "name": the tool to run.')
  if (isGatewayTool(target)) return refusal(`Call ${target} directly, not through call_tool.`)
  const raw = call.args.arguments ?? {}
  if (typeof raw !== 'object' || Array.isArray(raw)) return refusal('call_tool "arguments" must be an object.')

  // An unknown name is an error the model can act on, not a protocol error: say what is close.
  // A tool that exists but is not this caller's is refused by authorizeMcpTool below, word for
  // word as a direct call is.
  if (!getMcpTool(target)) {
    const close = closeMatches(target, call.access)
    return refusal(
      `Unknown tool: ${target}.` +
      (close.length ? ` Did you mean: ${close.join(', ')}?` : '') +
      ' search_tools lists the tools you may use.'
    )
  }
  return callMcpTool({ ...call, name: target, args: raw as Record<string, unknown> })
}
