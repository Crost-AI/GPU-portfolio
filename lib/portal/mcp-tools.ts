/**
 * The investor connector's tools (app/api/portal/mcp): an LP's own portal, for an assistant.
 *
 * Every tool is a thin call into lib/portal/service.ts, the same functions the web portal's routes
 * call, with a principal already narrowed to the one fund the connection was made for
 * (lib/portal/principal.ts). So the connector can show nothing, and change nothing, the LP couldn't
 * on the web, and every view, download, acknowledgment and message lands in the same LP access log,
 * marked as coming through MCP.
 *
 * Two tools act for the LP, and need the `write` scope they agreed to on the consent screen:
 * acknowledging a capital call wire and messaging the fund. Uploads (onboarding documents) stay on
 * the web: a file is not something to hand an assistant.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  acknowledgeCapitalCall, portalDocumentUrl, portalDocuments, portalLetter, portalLetters, portalMessages,
  portalNotices, portalOnboarding, portalOverview, portalStatementFunds, sendPortalMessage, type LpPrincipal,
} from './service'
import { reportLinkUrl, signReportLink } from '@/lib/agent/report-links'

export interface PortalToolContext {
  admin: SupabaseClient
  principal: LpPrincipal
  /** The fund this connection is bound to. */
  fundId: string
  origin: string
}

export interface PortalTool {
  name: string
  title: string
  description: string
  scope: 'read' | 'write'
  inputSchema: Record<string, unknown>
  run(ctx: PortalToolContext, args: Record<string, unknown>): Promise<unknown>
}

const noArgs = { type: 'object', properties: {}, additionalProperties: false }

/** Letters are GP-authored HTML; an assistant wants the words. */
function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null
  return html
    .replace(/<\s*(br|\/p|\/tr|\/h\d|\/li)\s*\/?>/gi, '\n')
    .replace(/<\s*\/t[dh]\s*>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const PORTAL_TOOLS: PortalTool[] = [
  {
    name: 'portal_home',
    title: 'Investor portal home',
    description:
      'Start here. What this connection can show and do for the investor, and a short summary of their position. ' +
      'Call it when the user asks for help, says hi, or is unsure what to ask.',
    scope: 'read',
    inputSchema: noArgs,
    async run(ctx) {
      const [overview, notices] = await Promise.all([portalOverview(ctx.admin, ctx.principal), portalNotices(ctx.admin, ctx.principal)])
      const open = notices.filter(n => n.kind === 'capital_call' && n.status !== 'settled')
      return {
        investor: overview.investorName,
        position: overview.hasData ? overview : 'The fund has not published a capital statement to you yet.',
        openCapitalCalls: open.length,
        youCanAsk: [
          'How is my investment doing? (portal_overview)',
          'Get my capital account statement (statement_pdf)',
          'Show me the latest letter (list_letters, read_letter)',
          'What documents has the fund shared? (list_documents, get_document)',
          'Do I owe a capital call? (list_capital_notices)',
          "Tell the fund I've wired it (acknowledge_capital_call)",
          'Message the fund (send_message, list_messages)',
          'What paperwork is outstanding? (onboarding_status)',
        ],
      }
    },
  },
  {
    name: 'portal_overview',
    title: 'My position',
    description: "The investor's commitment, paid-in capital, distributions and NAV, in total and by vehicle, from the capital statement the fund has published to them.",
    scope: 'read',
    inputSchema: noArgs,
    run: ctx => portalOverview(ctx.admin, ctx.principal),
  },
  {
    name: 'statement_pdf',
    title: 'Capital account statement (PDF)',
    description:
      "A download link for the investor's live capital account statement as a PDF. The link works for one hour; " +
      'give it to the user as a link, and ask again for a fresh one later.',
    scope: 'read',
    inputSchema: noArgs,
    async run(ctx) {
      const funds = await portalStatementFunds(ctx.admin, ctx.principal)
      if (!funds.includes(ctx.fundId)) return { available: false, reason: 'The fund has not published a capital statement to you yet.' }
      const { token, expiresAt } = signReportLink({ fundId: ctx.fundId, userId: ctx.principal.userId, kind: 'portal_statement', args: {} })
      return { available: true, url: reportLinkUrl(ctx.origin, token), expiresAt }
    },
  },
  {
    name: 'list_letters',
    title: 'Letters',
    description: 'The quarterly letters the fund has shared with the investor, newest first, with when they last read each.',
    scope: 'read',
    inputSchema: noArgs,
    run: ctx => portalLetters(ctx.admin, ctx.principal),
  },
  {
    name: 'read_letter',
    title: 'Read a letter',
    description: 'The full text of one shared letter, by the id from list_letters.',
    scope: 'read',
    inputSchema: { type: 'object', properties: { letter_id: { type: 'string', description: 'From list_letters.' } }, required: ['letter_id'], additionalProperties: false },
    async run(ctx, args) {
      const letter = await portalLetter(ctx.admin, ctx.principal, String(args.letter_id ?? ''))
      return {
        id: letter.id,
        period: letter.period_label,
        text: letter.full_draft,
        portfolioTable: htmlToText(letter.portfolio_table_html),
        companyNarratives: letter.company_narratives,
      }
    },
  },
  {
    name: 'list_documents',
    title: 'Documents',
    description: 'Documents the fund has shared with the investor (fund-wide and their own), newest first.',
    scope: 'read',
    inputSchema: noArgs,
    run: ctx => portalDocuments(ctx.admin, ctx.principal),
  },
  {
    name: 'get_document',
    title: 'Get a document',
    description: 'A download link for one shared document, by the id from list_documents. The link works for one hour.',
    scope: 'read',
    inputSchema: { type: 'object', properties: { document_id: { type: 'string', description: 'From list_documents.' } }, required: ['document_id'], additionalProperties: false },
    async run(ctx, args) {
      const doc = await portalDocumentUrl(ctx.admin, ctx.principal, String(args.document_id ?? ''), { ttlSeconds: 60 * 60 })
      return { title: doc.title, fileName: doc.fileName, url: doc.url }
    },
  },
  {
    name: 'list_capital_notices',
    title: 'Capital calls and distributions',
    description:
      "Every capital call and distribution for the investor, with the amount, what's been settled, what's outstanding, " +
      "the due date, and whether they've already told the fund they wired it.",
    scope: 'read',
    inputSchema: noArgs,
    run: ctx => portalNotices(ctx.admin, ctx.principal),
  },
  {
    name: 'list_messages',
    title: 'Messages',
    description: "The investor's messages with the fund, oldest first, including the fund's announcements and replies.",
    scope: 'read',
    inputSchema: noArgs,
    run: ctx => portalMessages(ctx.admin, ctx.principal),
  },
  {
    name: 'onboarding_status',
    title: 'Onboarding paperwork',
    description:
      'What onboarding paperwork the fund still needs from each of the investor\'s entities, and the status of each item. ' +
      'Documents are uploaded in the investor portal on the web, not here.',
    scope: 'read',
    inputSchema: noArgs,
    async run(ctx) {
      const r = await portalOnboarding(ctx.admin, ctx.principal)
      return { entities: r.entities, uploadIn: `${ctx.origin}/portal/onboarding` }
    },
  },
  {
    name: 'acknowledge_capital_call',
    title: "Tell the fund I've wired a capital call",
    description:
      "Records the investor's word that they've wired a capital call, on the line from list_capital_notices. " +
      "It's their acknowledgment, not a settlement: the call settles when the fund's books show the money. " +
      'Confirm the call, the date wired and any reference with the user before calling.',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        line_id: { type: 'string', description: 'lineId of the capital call, from list_capital_notices.' },
        wired_on: { type: 'string', description: 'The date wired, YYYY-MM-DD.' },
        reference: { type: 'string', description: 'The bank reference, if any.' },
        note: { type: 'string', description: 'Anything else for the fund.' },
      },
      required: ['line_id'],
      additionalProperties: false,
    },
    run: (ctx, args) => acknowledgeCapitalCall(ctx.admin, ctx.principal, { lineId: args.line_id, wiredOn: args.wired_on, reference: args.reference, note: args.note }),
  },
  {
    name: 'send_message',
    title: 'Message the fund',
    description: "Sends the fund a message in the investor's name, to their portal inbox and by email to the fund's admins. Show the user the message and confirm before sending.",
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: { subject: { type: 'string' }, message: { type: 'string' } },
      required: ['message'],
      additionalProperties: false,
    },
    run: (ctx, args) => sendPortalMessage(ctx.admin, ctx.principal, { subject: args.subject, message: args.message }),
  },
]

export function getPortalTool(name: unknown): PortalTool | undefined {
  return PORTAL_TOOLS.find(t => t.name === name)
}

/** The tools a token with this scope may call. A read-only connection is never shown the write tools. */
export function portalToolsFor(scope: string): PortalTool[] {
  const canWrite = scope.split(/\s+/).includes('write')
  return PORTAL_TOOLS.filter(t => t.scope === 'read' || canWrite)
}
