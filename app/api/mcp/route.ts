/**
 * The canonical MCP endpoint: POST /api/mcp
 *
 * The original path was /api/accounting/mcp, from when the server exposed only
 * ledger tools. It has since grown a whole portfolio domain (companies,
 * investments, LP positions, fund performance), so `/funds/` is now a
 * misnomer for roughly a third of what it does.
 *
 * This is the address to give people. /api/accounting/mcp still works and is not
 * deprecated in any breaking sense — existing keys and configs keep running — but
 * everything new (the OAuth resource metadata, the settings UI) points here.
 */
// Reviewed for the Next 16 async-params change: neither handler takes route `params` — the route
// has no dynamic segment, and the `params` they do read are the JSON-RPC body's.
export { POST, GET } from '@/app/api/accounting/mcp/route'

export const runtime = 'nodejs'
// A submitted company update runs the extraction pipeline in the call (submit_company_update), as
// an emailed one does in /api/inbound-email.
export const maxDuration = 120
export const dynamic = 'force-dynamic'
