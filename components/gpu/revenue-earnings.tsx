'use client'

import { Fragment } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { cn } from '@/lib/utils'
import { ACCOUNTING_WRITE_HINT } from './fleet-ui'
import {
  BUSY_STATUSES, EARNING_STATUS_LABEL, EARNING_STATUS_TONE, groupByPeriod, selectable,
  type EarningView, type NeedsReversal,
} from './revenue-api'
import type { EarningStatus } from '@/lib/gpu/ops/types'

// ── GPU fleet (P5) ── The entered periods: what was staged, what is posted, what was set aside.
// Posting books revenue (Dr 1150 / Cr 4000, the fee to 5150), so it also needs Accounting write.
// A staged row that replaces a posted period is posted only after the user confirms the reversal.

export const OPS_WRITE_HINT = 'Entering or ignoring operations needs write access to the GPU fleet.'
export const POST_HINT_NO_BOOKS = `Posting revenue: ${ACCOUNTING_WRITE_HINT}`
export const POST_HINT_NO_FLEET = 'Posting revenue needs write access to the GPU fleet as well as Accounting.'

export function EarningStatusBadge({ status }: { status: EarningStatus }) {
  const busy = BUSY_STATUSES.includes(status)
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-caption font-medium', EARNING_STATUS_TONE[status] ?? 'bg-muted text-muted-foreground')}
      data-status={status} aria-busy={busy || undefined}>
      {busy && <Loader2 className="h-3 w-3 animate-spin" />}
      {EARNING_STATUS_LABEL[status] ?? status}
    </span>
  )
}

/** Which grant, if any, is missing to post. */
export function postHint(canWriteFleet: boolean, canBook: boolean): string | null {
  if (!canWriteFleet) return POST_HINT_NO_FLEET
  if (!canBook) return POST_HINT_NO_BOOKS
  return null
}

const num = (n: number | null, dp = 2) => (n == null ? '—' : n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: dp }))

export function EarningsTable({ rows, money, selected, onToggle, canWriteFleet, canBook, busy, onPost, onIgnore }: {
  rows: EarningView[]
  money: (n: number) => string
  selected: Set<string>
  onToggle: (id: string) => void
  canWriteFleet: boolean
  canBook: boolean
  busy: 'post' | 'ignore' | null
  onPost: () => void
  onIgnore: () => void
}) {
  if (rows.length === 0) return <EmptyState compact>No periods entered in this range.</EmptyState>
  const replacedBy = new Map(rows.filter(r => r.supersedesId).map(r => [r.supersedesId!, r]))
  const groups = groupByPeriod(rows)
  const chosen = rows.filter(r => selected.has(r.id))
  const hint = postHint(canWriteFleet, canBook)
  const postable = chosen.length > 0 && chosen.every(r => r.status === 'staged')
  const ignorable = chosen.length > 0 && chosen.every(selectable)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-sm text-muted-foreground tabular-nums">{chosen.length} selected</span>
        <Button type="button" size="sm" variant="outline" data-action="ignore" disabled={!canWriteFleet || !ignorable || busy != null}
          title={!canWriteFleet ? OPS_WRITE_HINT : ignorable ? undefined : 'Select staged or unmatched rows to ignore'} onClick={onIgnore}>
          {busy === 'ignore' && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Ignore selected
        </Button>
        <Button type="button" size="sm" data-action="post" disabled={hint != null || !postable || busy != null} title={hint ?? (postable ? undefined : 'Select staged rows to post')} onClick={onPost}>
          {busy === 'post' && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Post selected
        </Button>
      </div>
      {hint && <p className="text-caption text-muted-foreground" data-hint="post">{hint}</p>}

      <div className="overflow-x-auto rounded-card border">
        <table className="w-full text-sm" data-region="earnings">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th scope="col" className="w-8 px-2 py-2"><span className="sr-only">Select</span></th>
              {['Server', 'GPU-hours', 'Utilization', 'Gross', 'Fee', 'Net', 'Downtime', 'Status'].map((h, i) => (
                <th key={h} scope="col" className={cn('whitespace-nowrap px-3 py-2 font-medium', i >= 1 && i <= 6 ? 'text-right' : 'text-left')}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map(g => (
              <Fragment key={g.period}>
                <tr className="border-t bg-muted/20">
                  <th scope="rowgroup" colSpan={9} className="px-3 py-1.5 text-left text-xs font-medium text-muted-foreground tabular-nums">{g.start} to {g.end}</th>
                </tr>
                {g.rows.map(r => {
                  const by = replacedBy.get(r.id)
                  return (
                    <tr key={r.id} id={`earning-${r.id}`} className="border-t" data-earning={r.id}>
                      <td className="px-2 py-2">
                        {selectable(r) && (
                          <input type="checkbox" aria-label={`Select ${r.assetName ?? r.assetRef} ${g.start} to ${g.end}`}
                            checked={selected.has(r.id)} onChange={() => onToggle(r.id)} disabled={busy != null} />
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {r.assetName ?? <span className="text-warning">{r.assetRef}</span>}
                        {r.status === 'unmatched' && (
                          <p className="text-caption text-muted-foreground">No server is named &ldquo;{r.assetRef}&rdquo;. Re-enter it under the server&rsquo;s name, then ignore this row.</p>
                        )}
                        {r.supersedesId && r.status === 'staged' && (
                          <p className="text-caption text-muted-foreground">Replaces a posted period: posting it reverses that entry first.</p>
                        )}
                        {r.status === 'reversed' && by && (
                          <p className="text-caption text-muted-foreground"><a href={`#earning-${by.id}`} className="underline underline-offset-2">Replaced by a later entry</a></p>
                        )}
                        {r.note && <p className="text-caption text-muted-foreground">{r.note}</p>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{num(r.gpuHoursRented)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.utilizationPct == null ? '—' : `${num(r.utilizationPct, 1)}%`}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(r.gross)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(r.fee)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(r.net)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{num(r.downtimeHours)}</td>
                      <td className="px-3 py-2"><EarningStatusBadge status={r.status} /></td>
                    </tr>
                  )
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** The posted entries a post would reverse, listed before anything is reversed. */
export function ReversalConfirm({ open, entries, rows, busy, onCancel, onConfirm }: {
  open: boolean
  entries: NeedsReversal[]
  rows: EarningView[]
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const byId = new Map(rows.map(r => [r.id, r]))
  return (
    <Dialog open={open} onOpenChange={o => { if (!o && !busy) onCancel() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Reverse the posted periods?</DialogTitle>
          <DialogDescription>
            These rows replace periods already posted. Posting them reverses each posted entry first, then books the new figures.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-1.5 text-sm" data-region="needs-reversal">
          {entries.map(e => {
            const now = byId.get(e.id)
            const old = byId.get(e.supersedesId)
            return (
              <li key={e.id} className="rounded-lg border px-3 py-2" data-reversal={e.supersedesId}>
                <span className="font-medium">{now?.assetName ?? old?.assetName ?? now?.assetRef ?? 'Server'}</span>{' '}
                <span className="tabular-nums text-muted-foreground">{now ? `${now.periodStart} to ${now.periodEnd}` : ''}</span>
                <p className="text-caption text-muted-foreground">
                  Reverses the entry posted {e.entryDate ? <span className="tabular-nums">{e.entryDate}</span> : '(no entry: a zero-revenue period)'}
                  {old ? <> for net <span className="tabular-nums">{old.net.toFixed(2)}</span></> : null}
                </p>
              </li>
            )
          })}
        </ul>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button type="button" size="sm" onClick={onConfirm} disabled={busy} data-action="confirm-reversal">
            {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Reverse and post
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
