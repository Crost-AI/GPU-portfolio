'use client'

// The fund's approval queue, outside the Analyst panel.
//
// Changes staged from Claude, ChatGPT or a script (lib/agent/dispatch.ts) wait here until a member
// approves them. The panel lists them too, but the panel exists only when the fund has an AI key,
// and a fund that works from an external chat often has none — which left those changes with no
// button anywhere in the app.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ClipboardCheck } from 'lucide-react'
import type { StagedAction } from '@/components/analyst-pending-actions'

export interface QueuedAction extends StagedAction {
  createdVia?: string | null
  createdAt?: string
}

/** Every waiting action the caller may see, walking the route's cursor to the end. */
export function usePendingActions(): { actions: QueuedAction[]; loading: boolean; error: string | null } {
  const [actions, setActions] = useState<QueuedAction[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const all: QueuedAction[] = []
      let cursor: string | null = null
      // Bounded: 20 pages of 50 is far past any real queue, and a cursor bug must not spin forever.
      for (let page = 0; page < 20; page++) {
        const res: Response = await fetch(cursor ? `/api/pending-actions?cursor=${encodeURIComponent(cursor)}` : '/api/pending-actions')
        const data = await res.json().catch(() => null)
        if (!res.ok || !Array.isArray(data?.actions)) throw new Error(data?.error ?? 'The queue could not be loaded.')
        all.push(...data.actions)
        cursor = data.nextCursor ?? null
        if (!cursor) break
      }
      return all
    }
    load()
      .then(all => { if (!cancelled) setActions(all) })
      .catch(e => { if (!cancelled) setError((e as Error).message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  return { actions, loading, error }
}

/** A one-line pointer to the queue, shown only while something is waiting. */
export function PendingApprovalsNotice({ className }: { className?: string }) {
  const { actions } = usePendingActions()
  if (actions.length === 0) return null
  const n = actions.length
  return (
    <Link
      href="/pending-actions"
      className={`flex items-center gap-2 rounded-card border bg-warning-subtle px-3 py-2 text-sm hover:underline ${className ?? ''}`}
    >
      <ClipboardCheck className="h-4 w-4 shrink-0 text-warning" />
      {n === 1 ? '1 change is waiting for your approval.' : `${n} changes are waiting for your approval.`}
    </Link>
  )
}
