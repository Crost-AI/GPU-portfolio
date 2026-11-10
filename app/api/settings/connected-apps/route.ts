import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { audienceOf } from '@/lib/oauth/audience'

/**
 * The assistants a member has connected to the fund over OAuth (the MCP connector and the v1 API),
 * and disconnecting one. The consent screen promises "You can revoke this at any time in
 * Settings"; this is that.
 *
 *   GET                       { connections: [{ clientId, clientName, redirectHost, canAct, connectedAt, lastUsedAt }] }
 *   DELETE ?client_id=…       revokes every token that assistant holds for this member and fund
 *
 * Only the caller's OWN tokens, and only the fund's: an investor-connector token (app/api/portal/mcp)
 * is listed and revoked from the portal (app/api/portal/connections), never here.
 */

async function ctx() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const admin = createAdminClient()
  const { data: m } = await admin.from('fund_members').select('fund_id').eq('user_id', user.id).maybeSingle()
  if (!m) return { error: NextResponse.json({ error: 'No fund found' }, { status: 403 }) }
  return { db: admin as any, userId: user.id, fundId: (m as { fund_id: string }).fund_id }
}

/** A fund token: issued for the MCP or v1 boundary, or before `resource` was recorded at all. */
const isFundToken = (resource: string | null) => audienceOf(resource) !== 'portal'

function hostOf(uri: string | undefined): string | null {
  if (!uri) return null
  try {
    return new URL(uri).host
  } catch {
    return null
  }
}

export async function GET() {
  const c = await ctx()
  if (c.error) return c.error

  const { data: tokens, error } = await c.db
    .from('oauth_tokens')
    .select('client_id, scope, resource, created_at, last_used_at, oauth_clients(client_name, redirect_uris)')
    .eq('user_id', c.userId)
    .eq('fund_id', c.fundId)
    .eq('kind', 'refresh')
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
  if (error) return NextResponse.json({ error: 'Could not load connected apps' }, { status: 500 })

  const byClient = new Map<string, any>()
  for (const t of (tokens ?? []) as any[]) {
    if (!isFundToken(t.resource)) continue
    const client = Array.isArray(t.oauth_clients) ? t.oauth_clients[0] : t.oauth_clients
    const prev = byClient.get(t.client_id)
    const lastUsedAt = [prev?.lastUsedAt, t.last_used_at].filter(Boolean).sort().at(-1) ?? null
    if (!prev || t.created_at > prev.connectedAt) {
      byClient.set(t.client_id, {
        clientId: t.client_id,
        // The name is the app's own description of itself (RFC 7591), so the host its codes go to
        // is shown beside it, as on the consent screen.
        clientName: client?.client_name ?? 'An assistant',
        redirectHost: hostOf(client?.redirect_uris?.[0]),
        canAct: String(t.scope ?? '').split(/\s+/).includes('write'),
        connectedAt: t.created_at,
        lastUsedAt,
      })
    } else {
      prev.lastUsedAt = lastUsedAt
    }
  }
  const connections = Array.from(byClient.values()).sort((a, b) => (a.connectedAt < b.connectedAt ? 1 : -1))
  return NextResponse.json({ connections })
}

export async function DELETE(req: NextRequest) {
  const c = await ctx()
  if (c.error) return c.error
  const clientId = req.nextUrl.searchParams.get('client_id') ?? ''
  if (!clientId) return NextResponse.json({ error: 'client_id is required' }, { status: 400 })

  // Access tokens as well as refresh tokens: revoking only the refresh token would leave the
  // assistant working until its current access token expires.
  const { data: tokens, error } = await c.db
    .from('oauth_tokens')
    .select('id, resource')
    .eq('user_id', c.userId)
    .eq('fund_id', c.fundId)
    .eq('client_id', clientId)
    .is('revoked_at', null)
  if (error) return NextResponse.json({ error: 'Could not disconnect' }, { status: 500 })

  const ids = ((tokens ?? []) as any[]).filter(t => isFundToken(t.resource)).map(t => t.id as string)
  if (ids.length > 0) {
    const { error: revokeError } = await c.db.from('oauth_tokens').update({ revoked_at: new Date().toISOString() }).in('id', ids)
    if (revokeError) return NextResponse.json({ error: 'Could not disconnect' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, revoked: ids.length })
}
