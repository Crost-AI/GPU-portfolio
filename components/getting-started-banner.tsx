'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ArrowRight, ListChecks, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

// ---------------------------------------------------------------------------
// Per-user "skip" and "dismiss" — browser-only conveniences.
//
// Nothing here is security-relevant: a skipped step is still computed from data and still shown
// (as skipped) on /getting-started, and the banner is an affordance. Every read and write is
// wrapped, because storage can throw (private windows, blocked site data) and the page has to
// render the same without it.
// ---------------------------------------------------------------------------

const skipKey = (userId: string) => `getting-started:skipped:${userId}`
const dismissKey = (userId: string) => `getting-started:banner-dismissed:${userId}`

export function readSkipped(userId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(skipKey(userId))
    const parsed = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [])
  } catch {
    return new Set()
  }
}

export function writeSkipped(userId: string, skipped: Set<string>): void {
  try {
    window.localStorage.setItem(skipKey(userId), JSON.stringify([...skipped]))
  } catch {
    // Storage unavailable: skipping simply does nothing in this browser.
  }
  window.dispatchEvent(new Event(SKIP_EVENT))
}

const SKIP_EVENT = 'getting-started:skips'

function subscribeSkips(onChange: () => void): () => void {
  window.addEventListener(SKIP_EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(SKIP_EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}

/**
 * The viewer's skipped step keys and a toggle. Read through useSyncExternalStore so the server
 * render (nothing skipped) and the first client render agree, then storage takes over.
 */
export function useSkippedSteps(userId: string): [Set<string>, (key: string) => void] {
  const raw = useSyncExternalStore(
    subscribeSkips,
    () => {
      try { return window.localStorage.getItem(skipKey(userId)) ?? '' } catch { return '' }
    },
    () => '',
  )
  // `raw` is the dependency: re-parse only when the stored string changes.
  const skipped = useMemo(() => (raw ? readSkipped(userId) : new Set<string>()), [raw, userId])
  const toggle = useCallback((key: string) => {
    const next = new Set(readSkipped(userId))
    if (next.has(key)) next.delete(key)
    else next.add(key)
    writeSkipped(userId, next)
  }, [userId])
  return [skipped, toggle]
}

function readDismissed(userId: string): boolean {
  try {
    return window.localStorage.getItem(dismissKey(userId)) === '1'
  } catch {
    return false
  }
}

function writeDismissed(userId: string): void {
  try {
    window.localStorage.setItem(dismissKey(userId), '1')
  } catch {
    // ignore
  }
}

interface ProgressPayload {
  userId: string
  steps: { key: string; status: 'done' | 'todo' | 'blocked' | 'not_applicable' }[]
}

/** Done / total with the viewer's skipped (unfinished) steps left out of the total. */
function count(steps: ProgressPayload['steps'], skipped: Set<string>) {
  const counted = steps.filter(s => s.status !== 'not_applicable' && !(s.status !== 'done' && skipped.has(s.key)))
  const done = counted.filter(s => s.status === 'done').length
  return { done, total: counted.length }
}

/**
 * "Finish setting up — N of M done → Continue", at the top of /start and /dashboard.
 *
 * Admins only, and only while the checklist is unfinished. Both host pages are client components,
 * so the count comes from GET /api/onboarding/progress (admin-gated) rather than server props.
 * Renders nothing until it knows there is something to say — no skeleton, no layout shift for
 * the common case of a fund that finished setting up long ago.
 */
export function GettingStartedBanner({ isAdmin, className }: { isAdmin: boolean; className?: string }) {
  const [state, setState] = useState<{ userId: string; done: number; total: number } | null>(null)

  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    fetch('/api/onboarding/progress')
      .then(res => (res.ok ? (res.json() as Promise<ProgressPayload>) : null))
      .then(data => {
        if (cancelled || !data?.userId || !Array.isArray(data.steps)) return
        if (readDismissed(data.userId)) return
        const { done, total } = count(data.steps, readSkipped(data.userId))
        if (total === 0 || done >= total) return
        setState({ userId: data.userId, done, total })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [isAdmin])

  if (!isAdmin || !state) return null
  const pct = Math.round((state.done / state.total) * 100)

  return (
    <div className={`rounded-card border border-brand-200 bg-brand-50 p-3 dark:border-brand-800 dark:bg-brand-950 ${className ?? ''}`}>
      <div className="flex items-center gap-3">
        <ListChecks className="h-4 w-4 shrink-0 text-brand-700 dark:text-brand-400" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            Finish setting up{' '}
            <span className="font-normal text-muted-foreground">
              — <span className="tabular-nums">{state.done}</span> of <span className="tabular-nums">{state.total}</span> done
            </span>
          </p>
          <div
            className="mt-1.5 h-1 w-full max-w-xs overflow-hidden rounded-full bg-background"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={state.total}
            aria-valuenow={state.done}
            aria-label="Setup progress"
          >
            <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <Button asChild size="sm" className="shrink-0">
          <Link href="/getting-started">
            Continue <ArrowRight />
          </Link>
        </Button>
        <button
          type="button"
          onClick={() => { writeDismissed(state.userId); setState(null) }}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
