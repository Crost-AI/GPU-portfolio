import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveAccessToken } from '@/lib/oauth/store'
import { issuerFor, wwwAuthenticate, PORTAL_MCP_PATH } from '@/lib/oauth/metadata'
import { withChangeSource } from '@/lib/audit/source'
import { DASHBOARD_RESOURCE_URI, listResources, negotiateProtocolVersion, readResource } from '@/lib/mcp-apps/server'
import { isDashboardPayload } from '@/lib/mcp-apps/payload'
import { rateLimit } from '@/lib/rate-limit'
import { connectorPrincipal, lpConnectorEnabled } from '@/lib/portal/principal'
import { getPortalTool, portalToolsFor, type PortalToolContext } from '@/lib/portal/mcp-tools'
import { PortalError } from '@/lib/portal/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The investor connector: an LP's own portal over MCP (Streamable HTTP, stateless JSON mode).
//
// AUTH — an OAuth access token issued for THIS resource only (lib/oauth/audience.ts, 'portal'),
// bound at consent to one fund the LP invests in. A fund member's token is refused here, and this
// token is refused at the fund's endpoints. No API keys: an investor connects through the consent
// screen.
//
// Re-checked on every request, never baked into the token (lib/portal/principal.ts): the LP account
// still active and still invested in the fund, and the fund's LP portal and investor connector both
// still on. Either switch off, or the LP disabled, and the next call is refused.
//
// Everything an LP sees or does here goes through lib/portal/service.ts, the same functions as the
// web portal, and lands in the LP access log marked as MCP.

const SERVER_INFO = { name: 'investor-portal', title: 'Investor portal', version: '0.1.0' }

const SERVER_INSTRUCTIONS =
  "This is an investor's own portal for one fund: their capital account, the fund's letters and documents shared " +
  'with them, capital calls, and messages with the fund. When the user asks for help, says hi, or is unsure what ' +
  'to ask, call portal_home. Figures come from what the fund has published to the investor; never estimate them. ' +
  'Before acknowledging a capital call or sending a message, show the user exactly what will be sent and confirm.'

interface RpcRequest { jsonrpc: string; id?: string | number | null; method: string; params?: any }

function ok(id: any, result: any) {
  return { jsonrpc: '2.0', id, result }
}
function err(id: any, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function describe(t: ReturnType<typeof portalToolsFor>[number]) {
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: { title: t.title, readOnlyHint: t.scope === 'read', destructiveHint: false, openWorldHint: false },
    // Drawn by the fund connector's own dashboard view (lib/mcp-apps/server.ts), served below.
    ...(t.ui ? {
      _meta: {
        ui: { resourceUri: DASHBOARD_RESOURCE_URI },
        'ui/resourceUri': DASHBOARD_RESOURCE_URI,
        'openai/outputTemplate': DASHBOARD_RESOURCE_URI,
        'openai/toolInvocation/invoking': 'Loading your position',
        'openai/toolInvocation/invoked': 'Position ready',
      },
    } : {}),
  }
}

async function handle(rpc: RpcRequest, ctx: PortalToolContext, scope: string): Promise<any | null> {
  switch (rpc?.method) {
    case 'initialize':
      return ok(rpc.id, {
        protocolVersion: negotiateProtocolVersion(rpc.params?.protocolVersion),
        capabilities: { tools: {}, resources: {} },
        serverInfo: { ...SERVER_INFO, websiteUrl: ctx.origin },
        instructions: SERVER_INSTRUCTIONS,
      })
    case 'ping':
      return ok(rpc.id, {})
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null
    case 'tools/list':
      return ok(rpc.id, { tools: portalToolsFor(scope).map(describe) })
    case 'tools/call': {
      const tool = getPortalTool(rpc.params?.name)
      if (!tool) return err(rpc.id, -32602, `Unknown tool: ${rpc.params?.name}`)
      if (!portalToolsFor(scope).includes(tool)) {
        return ok(rpc.id, {
          content: [{ type: 'text', text: 'This connection is read-only. Reconnect and allow it to act for you to use this.' }],
          isError: true,
        })
      }
      try {
        const result = await tool.run(ctx, rpc.params?.arguments ?? {})
        // A dashboard: the whole payload for the view, the figures (not the theme) for the model.
        if (tool.ui && isDashboardPayload(result)) {
          const forModel = { dashboard: result.title, scope: result.subtitle, data: result.data }
          return ok(rpc.id, { content: [{ type: 'text', text: JSON.stringify(forModel) }], structuredContent: result })
        }
        return ok(rpc.id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: wrap(result) })
      } catch (e) {
        // A PortalError is a refusal or a bad argument, worded for the user. Anything else is ours.
        if (!(e instanceof PortalError)) console.error('[portal/mcp]', tool.name, e)
        const text = e instanceof PortalError ? (e.status === 404 ? 'Not found, or not shared with you.' : e.message) : 'Something went wrong. Try again.'
        return ok(rpc.id, { content: [{ type: 'text', text }], isError: true })
      }
    }
    case 'resources/list':
      return ok(rpc.id, listResources())
    case 'resources/read': {
      const resource = readResource(rpc.params?.uri)
      return resource ? ok(rpc.id, resource) : err(rpc.id, -32002, `Resource not found: ${rpc.params?.uri}`)
    }
    case 'resources/templates/list':
      return ok(rpc.id, { resourceTemplates: [] })
    case 'prompts/list':
      return ok(rpc.id, { prompts: [] })
    default:
      return err(rpc?.id ?? null, -32601, `Method not found: ${rpc?.method}`)
  }
}

/** structuredContent must be an object. */
function wrap(result: unknown): Record<string, unknown> {
  return result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : { items: result }
}

const MAX_BATCH = 20

export async function POST(req: NextRequest) {
  return withChangeSource('mcp', () => handlePost(req))
}

async function handlePost(req: NextRequest) {
  const admin = createAdminClient()
  const unauthorized = (message: string) => NextResponse.json(err(null, -32001, message), {
    status: 401, headers: { 'WWW-Authenticate': wwwAuthenticate(req, PORTAL_MCP_PATH) },
  })

  const header = req.headers.get('authorization') ?? ''
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
  if (!bearer) return unauthorized('Unauthorized: connect through the investor portal sign-in')
  const token = await resolveAccessToken(admin, bearer, 'portal')
  if (!token) return unauthorized('Unauthorized: this sign-in is not valid for the investor connector')

  if (!(await lpConnectorEnabled(admin, token.fundId))) {
    return NextResponse.json(err(null, -32003, "The fund has turned off connecting an assistant to the investor portal."), { status: 403 })
  }
  const principal = await connectorPrincipal(admin, token.userId, token.fundId)
  if (!principal) {
    return NextResponse.json(err(null, -32003, 'Your investor access to this fund is no longer active.'), { status: 403 })
  }

  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json(err(null, -32700, 'Parse error'), { status: 400 })
  const calls: RpcRequest[] = Array.isArray(body) ? body : [body]
  if (calls.length > MAX_BATCH) {
    return NextResponse.json(err(null, -32600, `Batch too large: ${calls.length} calls. The limit is ${MAX_BATCH}.`), { status: 400 })
  }

  // Per LP account, every call in a batch counted, writes metered tighter (they email the fund).
  const isWrite = calls.some(c => c?.method === 'tools/call' && getPortalTool(c?.params?.name)?.scope === 'write')
  for (let i = 0; i < calls.length; i++) {
    const limited = await rateLimit({
      key: `portal-mcp:${isWrite ? 'w' : 'r'}:${principal.lpAccountId}`,
      limit: isWrite ? 20 : 120,
      windowSeconds: 60,
    })
    if (limited) return NextResponse.json(err(null, -32000, 'Rate limit exceeded. Slow down.'), { status: 429 })
  }

  const ctx: PortalToolContext = { admin, principal, fundId: token.fundId, origin: issuerFor(req) }
  const responses = []
  for (const rpc of calls) {
    const r = await handle(rpc, ctx, token.scope)
    if (r) responses.push(r)
  }
  if (!Array.isArray(body)) return responses[0] ? NextResponse.json(responses[0]) : new NextResponse(null, { status: 202 })
  return responses.length ? NextResponse.json(responses) : new NextResponse(null, { status: 202 })
}

export async function GET() {
  return NextResponse.json({ error: 'Use POST with JSON-RPC. This MCP server runs in stateless JSON mode.' }, { status: 405 })
}
