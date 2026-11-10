'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/confirm-dialog'
import { Section } from '@/components/settings/section'

interface Connection {
  clientId: string
  clientName: string
  redirectHost: string | null
  canAct: boolean
  connectedAt: string
  lastUsedAt: string | null
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

/**
 * The assistants this member has connected over OAuth (Claude, ChatGPT and other MCP clients), with
 * a Disconnect for each. Per-user: everyone sees and revokes only their own connections. The
 * consent screen tells people they can revoke access here.
 */
export function ConnectedAppsSection() {
  const confirm = useConfirm()
  const [connections, setConnections] = useState<Connection[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    fetch('/api/settings/connected-apps')
      .then(r => (r.ok ? r.json() : { connections: [] }))
      .then(d => setConnections(Array.isArray(d.connections) ? d.connections : []))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  async function disconnect(c: Connection) {
    const ok = await confirm({
      title: `Disconnect ${c.clientName}?`,
      description: 'It loses access to the fund straight away. You can connect it again later.',
      confirmLabel: 'Disconnect',
      variant: 'destructive',
    })
    if (!ok) return
    setBusy(c.clientId)
    setError(null)
    const res = await fetch(`/api/settings/connected-apps?client_id=${encodeURIComponent(c.clientId)}`, { method: 'DELETE' })
    setBusy(null)
    if (!res.ok) {
      setError('Could not disconnect. Try again.')
      return
    }
    setConnections(prev => prev.filter(x => x.clientId !== c.clientId))
  }

  return (
    <Section title="Connected apps">
      <p className="text-sm text-muted-foreground mb-3">
        Assistants you have connected to the fund. Disconnecting one revokes its access immediately.
      </p>
      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
      ) : connections.length === 0 ? (
        <p className="text-sm text-muted-foreground">No connected apps.</p>
      ) : (
        <ul className="divide-y">
          {connections.map(c => (
            <li key={c.clientId} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">
                  {c.clientName}
                  {c.redirectHost && <span className="font-normal text-muted-foreground"> · {c.redirectHost}</span>}
                </p>
                <p className="text-xs text-muted-foreground">
                  {c.canAct ? 'Can read and make changes' : 'Read only'} · connected {day(c.connectedAt)}
                  {c.lastUsedAt ? ` · last used ${day(c.lastUsedAt)}` : ''}
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={() => disconnect(c)} disabled={busy === c.clientId}>
                {busy === c.clientId && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}Disconnect
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-sm text-destructive mt-2">{error}</p>}
    </Section>
  )
}
