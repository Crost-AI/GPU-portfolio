import { NextRequest, NextResponse } from 'next/server'
import { sessionPrincipal } from '@/lib/portal/session'
import { lpFundsFor } from '@/lib/portal/principal'
import { audienceOf } from '@/lib/oauth/audience'

/**
 * LP portal — the investor connector from the investor's side (app/api/portal/mcp): whether their
 * fund has it on, the assistants they've connected, and disconnecting one.
 *
 *   GET                              { funds: [{ fundId, name, connectorOn }], connections: [...] }
 *   DELETE ?client_id=…&fund_id=…    revokes every token that assistant holds for that fund
 *
 * Only the investor connector's own tokens: a dual GP and LP never sees, or revokes, their fund
 * connections from here.
 */
export async function GET() {
  const s = await sessionPrincipal()
  if (s instanceof NextResponse) return s
  const db = s.admin as any

  const lp = await lpFundsFor(s.admin, s.principal.userId)
  const funds = lp?.funds ?? []
  const fundName = new Map(funds.map(f => [f.fundId, f.name]))

  const { data: tokens } = await db
    .from('oauth_tokens')
    .select('client_id, fund_id, scope, resource, created_at, last_used_at, oauth_clients(client_name)')
    .eq('user_id', s.principal.userId)
    .eq('kind', 'refresh')
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())

  const byKey = new Map<string, any>()
  for (const t of (tokens ?? []) as any[]) {
    if (audienceOf(t.resource) !== 'portal') continue
    const key = `${t.client_id}:${t.fund_id}`
    const prev = byKey.get(key)
    const client = Array.isArray(t.oauth_clients) ? t.oauth_clients[0] : t.oauth_clients
    if (!prev || t.created_at > prev.connectedAt) {
      byKey.set(key, {
        clientId: t.client_id,
        fundId: t.fund_id,
        clientName: client?.client_name ?? 'An assistant',
        fundName: fundName.get(t.fund_id) ?? 'Your fund',
        canAct: String(t.scope ?? '').split(/\s+/).includes('write'),
        connectedAt: t.created_at,
      })
    }
  }
  return NextResponse.json({ funds, connections: Array.from(byKey.values()) })
}

export async function DELETE(req: NextRequest) {
  const s = await sessionPrincipal()
  if (s instanceof NextResponse) return s
  const clientId = req.nextUrl.searchParams.get('client_id') ?? ''
  const fundId = req.nextUrl.searchParams.get('fund_id') ?? ''
  if (!clientId || !fundId) return NextResponse.json({ error: 'client_id and fund_id are required' }, { status: 400 })
  const db = s.admin as any

  const { data: tokens } = await db
    .from('oauth_tokens')
    .select('id, resource')
    .eq('user_id', s.principal.userId)
    .eq('client_id', clientId)
    .eq('fund_id', fundId)
    .is('revoked_at', null)
  const ids = ((tokens ?? []) as any[]).filter(t => audienceOf(t.resource) === 'portal').map(t => t.id as string)
  if (ids.length > 0) {
    const { error } = await db.from('oauth_tokens').update({ revoked_at: new Date().toISOString() }).in('id', ids)
    if (error) return NextResponse.json({ error: 'Could not disconnect' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, revoked: ids.length })
}
