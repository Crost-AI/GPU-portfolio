'use client'

import { useEffect, useReducer, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { todayLocalIso } from '@/lib/local-date'
import {
  declareRequest, initialInputs, lineLock, linesEditable, previewIdentity, previewRequest, refusal, send, waterfallPaths,
  type CashPreview, type Fetcher, type ProposalField, type ProposalInputs,
} from './waterfall-api'

// ── GPU fleet (P5) ── Propose a distribution: available cash, less the required reserve (Q5), through
// the distributable-cash waterfall. Preview, then declare exactly what was previewed.
//
// The server re-runs the waterfall at declare time for the distribution date and refuses lines that
// disagree with it (WATERFALL_MISMATCH). So the one date drives both the preview's `asOf` and the
// declaration's `distributionDate`, and any change to the date, the cash, the reserve or the
// contingency returned makes the preview stale: Declare stays off until Preview runs again.
// Editing an investor's amount keeps the preview but declares it as a manual split, as the
// capital-accounts page does.

export interface ProposalError { text: string; field?: ProposalField; previewAgain?: boolean }

export interface ProposalState {
  inputs: ProposalInputs
  /** One per dialog open, reused on every retry, so a double submit declares once. */
  requestKey: string
  preview: CashPreview | null
  /** The `asOf` the preview ran for: the declaration's `distributionDate`. */
  previewAsOf: string | null
  /** `previewKey` of the inputs the preview ran on. A reply that lands after an input changed is
   *  bound to the inputs it was asked for, not the ones now in the form. */
  previewedFor: string | null
  /** An input changed (or the server said the waterfall moved) since the preview. */
  stale: boolean
  /** Investor amounts typed over the preview's; null while untouched. */
  edits: Record<string, string> | null
  busy: 'preview' | 'declare' | null
  error: ProposalError | null
}

export type ProposalAction =
  | { type: 'reset'; state: ProposalState }
  | { type: 'input'; field: keyof ProposalInputs; value: string }
  | { type: 'previewStart' }
  | { type: 'previewDone'; preview: CashPreview; asOf: string; key: string }
  | { type: 'editLine'; lpEntityId: string; value: string }
  | { type: 'declareStart' }
  | { type: 'declareDone' }
  | { type: 'refused'; error: ProposalError }

/** The form as it opens: today's date, the last declared reserve (blank on the first), no preview. */
export function openProposal(lastReserve: number | null, today: string, requestKey: string): ProposalState {
  return { inputs: initialInputs(lastReserve, today), requestKey, preview: null, previewAsOf: null, previewedFor: null, stale: false, edits: null, busy: null, error: null }
}

const WATERFALL_INPUTS: (keyof ProposalInputs)[] = ['date', 'available', 'reserve', 'contingencyReturn']

/** The waterfall inputs as the preview request would send them, or null when they cannot be sent. */
export function previewKey(inputs: ProposalInputs): string | null {
  const req = previewRequest(inputs)
  return req.ok ? JSON.stringify(req.body) : null
}

export function proposalReducer(s: ProposalState, a: ProposalAction): ProposalState {
  switch (a.type) {
    case 'reset': return a.state
    case 'input': {
      const moves = WATERFALL_INPUTS.includes(a.field)
      return {
        ...s,
        inputs: { ...s.inputs, [a.field]: a.value },
        stale: s.stale || (moves && s.preview != null),
        error: s.error?.field === a.field ? null : s.error,
      }
    }
    case 'previewStart': return { ...s, busy: 'preview', error: null }
    // The inputs may have moved while the request was out: then the reply is shown, but stale.
    case 'previewDone': return { ...s, busy: null, preview: a.preview, previewAsOf: a.asOf, previewedFor: a.key, stale: previewKey(s.inputs) !== a.key, edits: null, error: null }
    // Locked when the preview pays a profit share or returns contingency (lineLock).
    case 'editLine': return s.preview && linesEditable(s.preview) ? { ...s, edits: { ...(s.edits ?? {}), [a.lpEntityId]: a.value } } : s
    case 'declareStart': return { ...s, busy: 'declare', error: null }
    case 'declareDone': return { ...s, busy: null }
    // A refused preview drops the one before it: the latest answer for these inputs is "no", and
    // the earlier preview (say, a waterfall that has since fallen back to pro-rata) must not stay
    // declarable. A refused declaration keeps its preview, stale if the books moved under it.
    case 'refused': return s.busy === 'preview'
      ? { ...s, busy: null, error: a.error, preview: null, previewAsOf: null, previewedFor: null, edits: null, stale: false }
      : { ...s, busy: null, error: a.error, stale: s.stale || !!a.error.previewAgain }
  }
}

/** Declare only from a preview whose inputs have not changed since, and whose tiers add up. */
export function canDeclare(s: ProposalState): boolean {
  if (s.preview == null || s.stale || s.busy != null || s.previewedFor == null || s.previewedFor !== previewKey(s.inputs)) return false
  // The panel says "do not declare" when a waterfall preview's tiers miss available − reserve.
  return s.preview.method !== 'waterfall' || previewIdentity(s.preview).holds
}


/** Preview: the inputs checked here first (a missing reserve never leaves the page), then the route. */
export async function previewAction(fetcher: Fetcher, inputs: ProposalInputs): Promise<ProposalAction> {
  const req = previewRequest(inputs)
  if (!req.ok) return { type: 'refused', error: { text: req.error, field: req.field } }
  const r = await send<CashPreview>(fetcher, waterfallPaths.distributions, 'POST', req.body)
  if (!r.ok) return { type: 'refused', error: refusal(r) }
  if (r.data.distributable == null) {
    return { type: 'refused', error: { text: 'This vehicle\u2019s waterfall is not set to distributable cash, so it cannot be split from available cash and a reserve. Set the terms, or declare from Capital accounts.' } }
  }
  // Only the waterfall stores a contingency return (wf_contingency_return). A preview that fell back
  // to pro-rata would declare it as an ordinary distribution, and later replays would treat that
  // cash as preferred return, so it is not offered for declaration at all.
  if (req.body.contingencyReturn > 0 && r.data.method !== 'waterfall') {
    return { type: 'refused', error: { field: 'contingencyReturn', text: `A contingency return can only be declared through the waterfall, and this preview fell back to a pro-rata split${r.data.warnings[0] ? ` (${r.data.warnings[0]})` : ''}. Set the contingency returned to 0, or fix the waterfall terms and preview again.` } }
  }
  return { type: 'previewDone', preview: r.data, asOf: req.body.asOf, key: JSON.stringify(req.body) }
}

/** Declare what was previewed, under the dialog's one request key. */
export async function declareAction(fetcher: Fetcher, state: ProposalState): Promise<ProposalAction> {
  if (!state.preview || !state.previewAsOf) return { type: 'refused', error: { text: 'Preview the distribution first.' } }
  // The button is off for a stale preview; this holds the request to the same rule.
  if (!canDeclare(state)) return { type: 'refused', error: { text: 'The inputs changed since the preview; preview again before declaring.' } }
  const req = declareRequest({ preview: state.preview, asOf: state.previewAsOf, description: state.inputs.description, requestKey: state.requestKey, edits: state.edits })
  if (!req.ok) return { type: 'refused', error: { text: req.error } }
  const r = await send(fetcher, waterfallPaths.distributions, 'POST', req.body)
  if (!r.ok) return { type: 'refused', error: refusal(r) }
  return { type: 'declareDone' }
}

/** The dialog, wired: the button that opens it, and the requests behind Preview and Declare. */
export function ProposeDistributionDialog({ fetcher, lastReserve, seesCarry, allowed, money, onPreviewed, onDeclared }: {
  fetcher: Fetcher
  lastReserve: number | null
  seesCarry: boolean
  /** lp_capital write: the declare route needs it. */
  allowed: boolean
  money: (n: number) => string
  onPreviewed: (lastReserve: number | null) => void
  onDeclared: () => void
}) {
  const [open, setOpen] = useState(false)
  // One per opening of the dialog, so a reply that lands after it closed is dropped.
  const session = useRef(0)
  const [state, dispatch] = useReducer(proposalReducer, null, () => openProposal(null, '', ''))

  function start() {
    session.current += 1
    dispatch({ type: 'reset', state: openProposal(lastReserve, todayLocalIso(), crypto.randomUUID()) })
    setOpen(true)
  }

  async function preview() {
    const mine = session.current
    dispatch({ type: 'previewStart' })
    const a = await previewAction(fetcher, state.inputs)
    // Closed or reopened while the request was out: the reply belongs to a form that is gone.
    if (mine !== session.current) return
    dispatch(a)
    if (a.type === 'previewDone') onPreviewed(a.preview.lastReserve)
  }

  async function declare() {
    if (!canDeclare(state)) return
    dispatch({ type: 'declareStart' })
    const a = await declareAction(fetcher, state)
    dispatch(a)
    if (a.type === 'declareDone') { setOpen(false); onDeclared() }
  }

  return (
    <>
      <div className="flex flex-col items-end gap-1">
        <Button size="sm" onClick={start} disabled={!allowed} title={allowed ? undefined : 'Declaring a distribution needs write access to investors’ capital'}>
          Propose a distribution
        </Button>
        {!allowed && <p className="text-caption text-muted-foreground">Needs write access to investors&rsquo; capital.</p>}
      </div>
      <Dialog open={open} onOpenChange={o => { if (!o && state.busy !== 'declare') { session.current += 1; setOpen(false) } }}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Propose a distribution</DialogTitle>
            <DialogDescription>The reserve is held back first; the rest runs through the waterfall.</DialogDescription>
          </DialogHeader>
          <ProposalForm state={state} dispatch={dispatch} seesCarry={seesCarry} money={money} onPreview={preview} onDeclare={declare} />
        </DialogContent>
      </Dialog>
    </>
  )
}

const FIELD_ID: Record<ProposalField, string> = { date: 'wf-date', available: 'wf-available', reserve: 'wf-reserve', contingencyReturn: 'wf-contingency' }

/** The form and the preview it shows, from state. Rendered statically by the tests. */
export function ProposalForm({ state, dispatch, seesCarry, money, onPreview, onDeclare }: {
  state: ProposalState
  dispatch: (a: ProposalAction) => void
  seesCarry: boolean
  money: (n: number) => string
  onPreview: () => void
  onDeclare: () => void
}) {
  const refs = useRef<Partial<Record<ProposalField, HTMLInputElement | null>>>({})
  const errField = state.error?.field
  // A refusal that names a field (RESERVE_REQUIRED names the reserve) puts the cursor in it.
  useEffect(() => { if (errField) refs.current[errField]?.focus() }, [errField, state.error])

  const set = (field: keyof ProposalInputs) => (e: React.ChangeEvent<HTMLInputElement>) => dispatch({ type: 'input', field, value: e.target.value })
  const field = (f: ProposalField, label: string, hint: React.ReactNode, props: React.ComponentProps<typeof Input>) => (
    <div className="space-y-1.5">
      <Label htmlFor={FIELD_ID[f]} className="text-xs">{label}</Label>
      <Input
        id={FIELD_ID[f]}
        ref={el => { refs.current[f] = el }}
        value={state.inputs[f]}
        onChange={set(f)}
        aria-invalid={errField === f || undefined}
        aria-describedby={errField === f ? 'wf-error' : undefined}
        // Held while a preview is out, so the reply describes what the form shows. The key check
        // (previewedFor) still guards a reply that lands after the dialog was reopened.
        disabled={state.busy != null}
        {...props}
      />
      {hint && <p className="text-caption text-muted-foreground">{hint}</p>}
    </div>
  )

  const p = state.preview
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {field('date', 'Distribution date', 'The waterfall is run to this date, and the distribution is declared on it.', { type: 'date', required: true })}
        {field('available', 'Available cash', null, { inputMode: 'decimal', required: true, className: 'text-right tabular-nums' })}
        {field('reserve', 'Working-capital reserve (required)', 'Pre-filled with the last distribution’s reserve. Enter 0 to hold nothing back.', { inputMode: 'decimal', required: true, className: 'text-right tabular-nums' })}
        {field('contingencyReturn', 'Return of unspent contingency', 'Optional. Paid to investors first, as return of capital.', { inputMode: 'decimal', placeholder: '0', className: 'text-right tabular-nums' })}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="wf-description" className="text-xs">Description</Label>
        <Input id="wf-description" value={state.inputs.description} onChange={set('description')} placeholder="Q3 2026 distribution" />
      </div>

      {state.error && (
        <p id="wf-error" role="alert" data-error={state.error.previewAgain ? 'preview-again' : state.error.field ?? 'general'}
          className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {state.error.text}
        </p>
      )}

      {p && <PreviewPanel state={state} preview={p} seesCarry={seesCarry} money={money} dispatch={dispatch} />}

      <DialogFooter className="gap-2">
        <Button type="button" variant="outline" onClick={onPreview} disabled={state.busy != null} data-action="preview">
          {state.busy === 'preview' && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          {p ? 'Preview again' : 'Preview'}
        </Button>
        <Button type="button" onClick={onDeclare} disabled={!canDeclare(state)} data-action="declare">
          {state.busy === 'declare' && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          Declare
        </Button>
      </DialogFooter>
    </div>
  )
}

const roundSum = (ns: number[]) => ns.reduce((t, n) => t + Math.round(n * 100), 0) / 100

function PreviewPanel({ state, preview: p, seesCarry, money, dispatch }: {
  state: ProposalState
  preview: CashPreview
  seesCarry: boolean
  money: (n: number) => string
  dispatch: (a: ProposalAction) => void
}) {
  const isWaterfall = p.method === 'waterfall'
  const identity = previewIdentity(p)
  const contingency = p.tiers.contingencyReturn ?? 0
  const lock = lineLock(p)
  const tierRows: [string, number, string?][] = [
    ['Return of unspent contingency', contingency, 'contingency'],
    ['Preferred return', p.tiers.preferred, 'preferred'],
    ['Return of capital', p.tiers.returnOfCapital, 'return-of-capital'],
    ['Profit to investors', p.tiers.profitToLP, 'profit-to-investors'],
    ...(seesCarry ? [
      ['Manager profit share', p.tiers.carry, 'manager-profit-share'] as [string, number, string],
      ['Manager share of return of capital', p.cash?.managerRocShare ?? 0, 'manager-roc-share'] as [string, number, string],
    ] : []),
  ]
  const row = 'flex items-baseline justify-between gap-3 py-1'
  return (
    <div className={cn('space-y-4 rounded-card border p-4', state.stale && 'opacity-60')} data-region="preview" data-stale={state.stale || undefined}>
      {state.stale && (
        <p className="rounded-lg bg-warning-subtle px-3 py-2 text-sm text-warning">
          The inputs changed since this preview. Preview again before declaring.
        </p>
      )}
      <dl className="grid gap-x-6 text-sm sm:grid-cols-3">
        <div className={row}><dt className="text-muted-foreground">Available</dt><dd className="tabular-nums">{money(p.available)}</dd></div>
        <div className={row}><dt className="text-muted-foreground">Reserve held back</dt><dd className="tabular-nums">{money(p.reserve)}</dd></div>
        <div className={row}><dt className="font-medium">Distributable</dt><dd className="font-medium tabular-nums" data-figure="distributable">{money(p.distributable)}</dd></div>
      </dl>

      {isWaterfall ? (
        <div className="space-y-2">
          <h3 className="text-base font-semibold">By tier</h3>
          <table className="w-full text-sm">
            <tbody>
              {tierRows.map(([label, n, key]) => (
                <tr key={key} className="border-b last:border-0" data-tier={key}>
                  <td className="py-1.5 text-muted-foreground">{label}</td>
                  <td className="py-1.5 text-right tabular-nums">{money(n)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className={cn('text-sm', identity.holds ? 'text-success' : 'text-destructive')} data-identity={identity.holds ? 'holds' : 'broken'}>
            {seesCarry
              ? `${money(contingency)} + ${money(p.tiers.preferred)} + ${money(p.tiers.returnOfCapital)} + ${money(p.tiers.profitToLP)} + ${money(p.tiers.carry)} + ${money(p.cash?.managerRocShare ?? 0)} = ${money(identity.sum)}; available less reserve ${money(identity.target)}`
              // Without gp_economics: the investors' side only. The check itself still covers every tier.
              : `To investors: ${money(contingency)} + ${money(p.tiers.preferred)} + ${money(p.tiers.returnOfCapital)} + ${money(p.tiers.profitToLP)} = ${money(roundSum([contingency, p.tiers.preferred, p.tiers.returnOfCapital, p.tiers.profitToLP]))}`}
            {identity.holds ? '. It adds up.' : '. It does not add up: do not declare; preview again.'}
          </p>
          {p.cash && (
            <dl className="grid gap-x-6 text-sm sm:grid-cols-3">
              <div className={row}><dt className="text-muted-foreground">Pref due</dt><dd className="tabular-nums">{money(p.cash.prefDue)}</dd></div>
              <div className={row}><dt className="text-muted-foreground">Pref carried forward</dt><dd className="tabular-nums">{money(p.cash.prefCarriedForward)}</dd></div>
              <div className={row}><dt className="text-muted-foreground">Unreturned after</dt><dd className="tabular-nums">{money(p.cash.unreturnedAfter)}</dd></div>
            </dl>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Split pro-rata by capital balance, not through the waterfall; the warnings below say why.</p>
      )}

      <div className="space-y-2">
        <h3 className="text-base font-semibold">To each investor</h3>
        {lock && <p className="text-caption text-muted-foreground" data-lines="locked">{lock}</p>}
        <div className="space-y-1.5">
          {p.lines.map(l => (
            <div key={l.lpEntityId} className="flex items-center justify-between gap-3 text-sm" data-line={l.lpEntityId}>
              {lock
                ? <span>{p.names[l.lpEntityId] ?? l.lpEntityId}</span>
                : <Label htmlFor={`wf-line-${l.lpEntityId}`} className="font-normal">{p.names[l.lpEntityId] ?? l.lpEntityId}</Label>}
              {lock ? (
                <span className="tabular-nums" data-line-amount={l.lpEntityId}>{money(l.amount)}</span>
              ) : (
                <Input
                  id={`wf-line-${l.lpEntityId}`}
                  inputMode="decimal"
                  className="h-8 w-40 text-right tabular-nums"
                  value={state.edits?.[l.lpEntityId] ?? String(l.amount)}
                  onChange={e => dispatch({ type: 'editLine', lpEntityId: l.lpEntityId, value: e.target.value })}
                />
              )}
            </div>
          ))}
        </div>
        {state.edits && <p className="text-sm text-warning">Edited &mdash; will be declared as a manual split, without the tiers.</p>}
      </div>

      {seesCarry && p.carryLines.length > 0 && (
        <div className="space-y-2" data-region="carry-lines">
          <h3 className="text-base font-semibold">Manager profit share</h3>
          {p.carryLines.map(l => (
            <div key={l.lpEntityId} className="flex items-baseline justify-between gap-3 text-sm">
              <span>{p.names[l.lpEntityId] ?? l.lpEntityId}</span>
              <span className="tabular-nums">{money(l.amount)}</span>
            </div>
          ))}
        </div>
      )}

      {p.warnings.length > 0 && (
        <ul className="space-y-1 rounded-lg bg-warning-subtle px-3 py-2 text-sm text-warning">
          {p.warnings.map(w => <li key={w}>{w}</li>)}
        </ul>
      )}
    </div>
  )
}
