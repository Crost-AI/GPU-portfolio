'use client'

// Writes the Analyst DRAFTED, rendered as reviewable cards. Nothing here has taken effect: each is
// a staged pending_action. Approve runs the real write (the same path the direct API uses); Reject
// discards it. Both endpoints re-check the caller's WRITE access for the action's domain.

import { useState } from 'react'
import { AlertTriangle, Check, CircleSlash, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { announceApplied } from '@/lib/pending-actions/applied-event'
import { isRunResult, RunPreview, RunResultView, type RunResult } from '@/components/agent-run-card'

export interface PreviewResult {
  summary: string
  details: Record<string, unknown>
}
export interface StagedAction {
  id: string
  actionType: string
  preview: PreviewResult
}

type CardState = 'idle' | 'busy' | 'applied' | 'rejected' | 'error'

export function AnalystPendingActions({ actions, title = 'Proposed changes — approve to apply' }: { actions: StagedAction[]; title?: string }) {
  const [state, setState] = useState<Record<string, CardState>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  // A run's outcome (lib/agent/run-action.ts): each step's result and the checks, shown once applied.
  const [runs, setRuns] = useState<Record<string, RunResult>>({})

  // Publishing to LPs asks twice: the first click only opens the confirmation (CONFIRM_IN_APP).
  const [confirming, setConfirming] = useState<Record<string, boolean>>({})

  async function act(a: StagedAction, kind: 'approve' | 'reject', confirmed = false) {
    setState(s => ({ ...s, [a.id]: 'busy' }))
    setErrors(e => ({ ...e, [a.id]: '' }))
    setConfirming(c => ({ ...c, [a.id]: false }))
    try {
      const res = await fetch(`/api/pending-actions/${a.id}/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(confirmed ? { confirmed: true } : {}),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.ok === false) {
        setState(s => ({ ...s, [a.id]: 'error' }))
        setErrors(e => ({ ...e, [a.id]: data.error ?? `Could not ${kind}` }))
        return
      }
      setState(s => ({ ...s, [a.id]: kind === 'approve' ? 'applied' : 'rejected' }))
      if (kind === 'approve' && isRunResult(data.result)) setRuns(r => ({ ...r, [a.id]: data.result }))
      if (kind === 'approve') announceApplied({ actionType: a.actionType, result: data.result })
    } catch {
      setState(s => ({ ...s, [a.id]: 'error' }))
      setErrors(e => ({ ...e, [a.id]: 'Network error.' }))
    }
  }

  // A rejected draft is gone: nothing more to do with it, so it leaves the panel.
  const shown = actions.filter(a => state[a.id] !== 'rejected')
  if (shown.length === 0) return null

  return (
    <div className="mt-2 space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      {shown.map(a => {
        const st = state[a.id] ?? 'idle'
        return (
          <div key={a.id} className="border rounded-card p-3 space-y-2">
            <p className="text-xs font-medium">{a.preview.summary}</p>
            {a.actionType === 'agent_run' ? (
              runs[a.id]
                ? <RunResultView id={a.id} result={runs[a.id]} onChange={next => setRuns(r => ({ ...r, [a.id]: next }))} />
                : <RunPreview details={a.preview.details} />
            ) : a.actionType === CONFIRM_TWICE ? (
              <CallNoticesPreview details={a.preview.details} />
            ) : (
              <PreviewDetails details={a.preview.details} />
            )}
            {st === 'applied' ? (
              <span className="text-xs text-success flex items-center gap-1">
                <Check className="h-3.5 w-3.5" />Applied.
              </span>
            ) : st === 'rejected' ? (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <X className="h-3.5 w-3.5" />Rejected.
              </span>
            ) : a.actionType === CONFIRM_TWICE && confirming[a.id] ? (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning bg-warning-subtle p-2">
                <span className="text-xs">{confirmLine(a.preview.details)}</span>
                <Button size="sm" onClick={() => act(a, 'approve', true)}>Yes, publish</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(c => ({ ...c, [a.id]: false }))}>Cancel</Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Button
                  size="sm" variant="outline"
                  onClick={() => a.actionType === CONFIRM_TWICE ? setConfirming(c => ({ ...c, [a.id]: true })) : act(a, 'approve')}
                  disabled={st === 'busy' || (a.actionType === CONFIRM_TWICE && hasBlocker(a.preview.details))}
                >
                  {st === 'busy' ? 'Working…' : a.actionType === CONFIRM_TWICE ? 'Approve publishing…' : 'Approve'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => act(a, 'reject')} disabled={st === 'busy'}>
                  Reject
                </Button>
              </div>
            )}
            {st === 'error' && errors[a.id] && <p className="text-sm text-destructive">{errors[a.id]}</p>}
          </div>
        )
      })}
    </div>
  )
}

/** Actions that publish to LPs: previewed per partner, and approved with a second confirmation. */
const CONFIRM_TWICE = 'publish_call_notices'

interface NoticeFlag { code: string; severity: 'blocker' | 'warning'; message: string }
interface NoticeMissing { field: string; label: string; why: string }
interface NoticePartner { lpEntityId: string; name: string; amount: number; share: number; alreadyPublished: boolean; portalAccount: string | null }

function hasBlocker(details: Record<string, unknown>): boolean {
  return ((details.flags as NoticeFlag[] | undefined) ?? []).some(f => f.severity === 'blocker')
}

function confirmLine(details: Record<string, unknown>): string {
  const n = Number(details.newNotices ?? 0)
  return `Publish ${n} notice${n === 1 ? '' : 's'} to partners' LP portals now? Partners can open ${n === 1 ? 'it' : 'them'} as soon as ${n === 1 ? 'it is' : 'they are'} published.`
}

/** A call's notices before they go out: each partner's figure, a DRAFT PDF of their notice, and the checks. */
function CallNoticesPreview({ details }: { details: Record<string, unknown> }) {
  const call = details.call as { id: string; noticeDate: string; dueDate: string | null; total: number } | undefined
  const partners = (details.partners as NoticePartner[] | undefined) ?? []
  const missing = (details.missing as NoticeMissing[] | undefined) ?? []
  const flags = (details.flags as NoticeFlag[] | undefined) ?? []
  const vehicle = String(details.vehicle ?? '')
  const pdf = (lp: string) =>
    `/api/accounting/notices/preview?group=${encodeURIComponent(vehicle)}&id=${encodeURIComponent(call?.id ?? '')}&lp=${encodeURIComponent(lp)}`
  return (
    <div className="space-y-2">
      {call && (
        <p className="text-xs text-muted-foreground tabular-nums">
          {vehicle} · dated {call.noticeDate} · due {call.dueDate ?? 'not stated'} · total {formatVal(call.total)}
        </p>
      )}
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted-foreground">
            <th className="text-left font-medium py-0.5">Partner</th>
            <th className="text-right font-medium py-0.5">Amount</th>
            <th className="text-right font-medium py-0.5">Share</th>
            <th className="text-left font-medium py-0.5 pl-3">Portal</th>
            <th className="py-0.5" />
          </tr>
        </thead>
        <tbody>
          {partners.map(p => (
            <tr key={p.lpEntityId} className="border-t">
              <td className="py-0.5">{p.name}</td>
              <td className="py-0.5 text-right tabular-nums">{formatVal(p.amount)}</td>
              <td className="py-0.5 text-right tabular-nums">{(p.share * 100).toFixed(2)}%</td>
              <td className="py-0.5 pl-3 text-muted-foreground">{p.alreadyPublished ? 'already published' : (p.portalAccount ?? 'no account yet')}</td>
              <td className="py-0.5 text-right">
                <a href={pdf(p.lpEntityId)} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">Preview</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {(missing.length > 0 || flags.length > 0) && (
        <div className="space-y-1 text-xs">
          {missing.map(m => (
            <p key={m.field} className="flex items-start gap-1.5">
              <CircleSlash className="h-3.5 w-3.5 mt-px shrink-0 text-muted-foreground" />
              <span><span className="font-medium">Missing: {m.label}.</span> <span className="text-muted-foreground">{m.why}</span></span>
            </p>
          ))}
          {flags.map((f, i) => (
            <p key={`${f.code}-${i}`} className="flex items-start gap-1.5">
              <AlertTriangle className={`h-3.5 w-3.5 mt-px shrink-0 ${f.severity === 'blocker' ? 'text-destructive' : 'text-warning'}`} />
              <span>{f.message}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

/** Render a preview's structured details: per-LP tables get a small table, everything else a list. */
function PreviewDetails({ details }: { details: Record<string, unknown> }) {
  const perLp = details.perLp as Array<{ lp: string; commitment?: number; amount: number }> | undefined
  const scalars = Object.entries(details).filter(([k]) => k !== 'perLp')

  return (
    <div className="space-y-1.5">
      {scalars.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
          {scalars.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="tabular-nums">{formatVal(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      {perLp && perLp.length > 0 && (
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-muted-foreground">
              <th className="text-left font-medium py-0.5">LP</th>
              <th className="text-right font-medium py-0.5">Amount</th>
            </tr>
          </thead>
          <tbody>
            {perLp.map((r, i) => (
              <tr key={i} className="border-t">
                <td className="py-0.5">{r.lp}</td>
                <td className="py-0.5 text-right tabular-nums">{formatVal(r.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function formatVal(v: unknown): string {
  if (v == null) return '—'
  if (typeof v === 'number') return v.toLocaleString()
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
