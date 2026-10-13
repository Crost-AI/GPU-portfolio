'use client'

import { ClipboardCheck } from 'lucide-react'
import { AnalystPendingActions } from '@/components/analyst-pending-actions'
import { usePendingActions } from '@/components/pending-approvals'
import { RecentRuns } from '@/components/agent-run-card'
import { EmptyState } from '@/components/ui/empty-state'

/**
 * Changes waiting for approval: staged from a connected chat (Claude, ChatGPT), a script, or the
 * Analyst. A client page, so it declares nothing in page-domains.ts: the queue arrives through
 * /api/pending-actions, which filters each row by the caller's read access, and Approve goes
 * through /api/pending-actions/[id]/approve, which re-checks write access per action.
 *
 * Below the queue, the latest runs (several changes staged as one, lib/agent/run-action.ts) that
 * were applied or stopped partway: each step's result, the checks, and Undo where it applies.
 */
export default function PendingActionsPage() {
  const { actions, loading, error } = usePendingActions()

  return (
    <div className="p-4 md:p-8">
      <div className="max-w-4xl space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
        <p className="text-sm text-muted-foreground">
          Changes staged from a connected chat or the Analyst. Nothing here has taken effect until you approve it.
        </p>
      </div>
      <div className="mt-6 max-w-4xl">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : actions.length === 0 ? (
          <EmptyState icon={ClipboardCheck}>Nothing is waiting for approval.</EmptyState>
        ) : (
          <AnalystPendingActions actions={actions} title={`${actions.length} waiting`} />
        )}
      </div>
      <div className="mt-8 max-w-4xl">
        <RecentRuns />
      </div>
    </div>
  )
}
