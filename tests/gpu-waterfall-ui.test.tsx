import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * ── GPU fleet (P5) ── The Waterfall & distributions page on the distributable_cash API (P5-3).
 *
 * Rendered statically, as the repo's other component tests are: the form, tables and gated regions
 * from props, and the requests through the same builders and actions the dialog calls, with a fake
 * fetcher. The fixture preview is the real engine's split for the pack's numbers (capital 1,435,500,
 * pref 8% on 30E/360, profit share 30%), not hand-typed figures.
 */

import { AccessProvider, type ClientAccess } from '@/components/access-context'
import { CurrencyProvider, formatCurrencyFull } from '@/components/currency-context'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { WaterfallView } from '@/components/gpu/waterfall-view'
import {
  ProposalForm, canDeclare, declareAction, openProposal, previewAction, previewKey, proposalReducer, type ProposalState,
} from '@/components/gpu/propose-distribution'
import { PrefLedgerTable, PrefLedgerUnavailable } from '@/components/gpu/pref-ledger-table'
import { DistributionHistory, TierBreakdown } from '@/components/gpu/distribution-history'
import { FeeTermsForm } from '@/components/gpu/fee-terms-dialog'
import { PositionTiles } from '@/components/gpu/waterfall-position'
import { CashTermsEditor } from '@/components/gpu/waterfall-terms-dialog'
import { dayCountLabel } from '@/components/gpu/waterfall-terms-card'
import {
  PREVIEW_AGAIN, feeFormOf, linesEditable, cashTermsBody, cashTermsFormOf, managerPct, type CashTermsForm, feeTermsBody, positionFromLedger, prefLedgerTotals, previewIdentity, send, unreturnedCapital,
  vehicleFetcher, type CashPreview, type Fetcher, type HistoryRow, type PrefLedgerRow,
} from '@/components/gpu/waterfall-api'
import { splitDistribution, suggestedCharacter, cashWaterfallEvents, cashWaterfallTerms } from '@/lib/accounting/distribution-waterfall'
import type { VehicleCarryTerms } from '@/lib/accounting/carry'
import { prefLedger, validateCashTerms } from '@/lib/gpu/waterfall'
import { FEE_BASES, FEE_FREQUENCIES } from '@/lib/gpu/fee'

const money = (n: number) => formatCurrencyFull(n, 'USD')

// ── Fixtures: the pack ─────────────────────────────────────────────────────────────────────────

const TERMS: VehicleCarryTerms = {
  kind: 'distributable_cash', carryRate: 0.3, prefRate: 0.08, catchupRate: 1, prefCompounds: false,
  gpEntityId: null, recipients: [{ lpEntityId: 'mgr', pct: 100 }],
  prefBasis: 'unreturned', prefDayCount: '30_360', rocLpShare: 1,
}
const CONTRIBUTIONS = [
  { date: '2026-01-01', lpEntityId: 'lp-a', amount: 1_000_000 },
  { date: '2026-01-01', lpEntityId: 'lp-b', amount: 435_500 },
]
const NAMES: Record<string, string> = { 'lp-a': 'Alder Partners', 'lp-b': 'Birch Capital', mgr: 'GPU Manager LLC' }
const ASOF = '2027-01-01'

/** The route's preview reply for `available`, `reserve` and `contingency`, from the real engine. */
function packPreview(available: number, reserve: number, contingencyReturn = 0, lastReserve: number | null = null): CashPreview {
  const total = Math.round((available - reserve) * 100) / 100
  const split = splitDistribution({
    total, terms: TERMS, asOf: ASOF, contingencyReturn, priors: [],
    contributions: CONTRIBUTIONS,
    partners: CONTRIBUTIONS.map(c => ({ lpEntityId: c.lpEntityId, contributed: c.amount, distributed: 0, ending: c.amount })),
  })
  return {
    ...split,
    names: Object.fromEntries([...split.lines, ...split.carryLines].map(l => [l.lpEntityId, NAMES[l.lpEntityId]])),
    suggestedCharacter: suggestedCharacter(split.tiers, total),
    terms: { kind: 'distributable_cash', carryRate: 0.3, prefRate: 0.08, recipients: ['GPU Manager LLC'], prefBasis: 'unreturned', prefDayCount: '30_360', rocLpShare: 1 },
    available, reserve, distributable: total, lastReserve,
  }
}

// Enough to return all the capital, pay the year's pref, and split a profit 70/30.
const PREVIEW = packPreview(2_000_000, 50_000, 10_000, 25_000)

/** A fetcher that answers each call from the queue, recording what was sent. */
function fakeFetcher(...responses: { status: number; body: unknown }[]) {
  const calls: { path: string; init?: RequestInit; body: any }[] = []
  const fetcher: Fetcher = async (path, init) => {
    calls.push({ path, init, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const r = responses.shift() ?? { status: 200, body: {} }
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } })
  }
  return { fetcher, calls }
}

const filled = (over: Partial<ProposalState['inputs']> = {}): ProposalState => {
  const s = openProposal(null, ASOF, 'key-1')
  return { ...s, inputs: { ...s.inputs, available: '2,000,000', reserve: '50000', contingencyReturn: '10000', description: 'Year one', ...over } }
}
const done = (s: ProposalState, preview: CashPreview = PREVIEW) =>
  proposalReducer(s, { type: 'previewDone', preview, asOf: s.inputs.date, key: previewKey(s.inputs)! })
const previewed = (s: ProposalState = filled()): ProposalState => done(s)

const form = (state: ProposalState, seesCarry = true) => renderToStaticMarkup(
  <ProposalForm state={state} dispatch={() => {}} seesCarry={seesCarry} money={money} onPreview={() => {}} onDeclare={() => {}} />,
)
/** Is the <button data-action=…> disabled? (Its classes mention `disabled:` regardless.) */
const disabled = (html: string, action: string) => /\sdisabled=""/.test(html.match(new RegExp(`<button[^>]*data-action="${action}"[^>]*>`))?.[0] ?? '')
const input = (html: string, id: string) => html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0] ?? ''

// ── Preview ────────────────────────────────────────────────────────────────────────────────────

describe('preview', () => {
  it('sends available, reserve, contingencyReturn, asOf = the date, through the waterfall', async () => {
    const { fetcher, calls } = fakeFetcher({ status: 200, body: PREVIEW })
    const a = await previewAction(fetcher, filled().inputs)
    expect(calls).toHaveLength(1)
    expect(calls[0].path).toBe('/api/accounting/distributions')
    expect(calls[0].init?.method).toBe('POST')
    expect(calls[0].body).toEqual({ action: 'preview', available: 2_000_000, reserve: 50_000, contingencyReturn: 10_000, asOf: ASOF, method: 'waterfall' })
    expect(a).toMatchObject({ type: 'previewDone', asOf: ASOF })
  })

  it('refuses a missing reserve on the page, before any request', async () => {
    const { fetcher, calls } = fakeFetcher()
    const a = await previewAction(fetcher, filled({ reserve: '' }).inputs)
    expect(calls).toHaveLength(0)
    expect(a).toMatchObject({ type: 'refused', error: { field: 'reserve' } })
  })

  it('refuses a reserve that is not below the cash available, and a contingency above what is distributed', async () => {
    const { fetcher, calls } = fakeFetcher()
    expect(await previewAction(fetcher, filled({ reserve: '2000000' }).inputs)).toMatchObject({ type: 'refused', error: { field: 'reserve' } })
    expect(await previewAction(fetcher, filled({ reserve: '-1' }).inputs)).toMatchObject({ type: 'refused', error: { field: 'reserve' } })
    expect(await previewAction(fetcher, filled({ contingencyReturn: '1950000.01' }).inputs)).toMatchObject({ type: 'refused', error: { field: 'contingencyReturn' } })
    expect(calls).toHaveLength(0)
  })

  it('a reserve of 0 is a reserve, and a blank contingency is 0', async () => {
    const { fetcher, calls } = fakeFetcher({ status: 200, body: PREVIEW })
    await previewAction(fetcher, filled({ reserve: '0', contingencyReturn: '' }).inputs)
    expect(calls[0].body).toMatchObject({ reserve: 0, contingencyReturn: 0 })
  })

  it('pins the vehicle on the query and the body', async () => {
    const { fetcher, calls } = fakeFetcher({ status: 200, body: PREVIEW })
    await previewAction(vehicleFetcher('GPU SPV I', fetcher), filled().inputs)
    expect(calls[0].path).toBe('/api/accounting/distributions?group=GPU%20SPV%20I')
    expect(calls[0].body.group).toBe('GPU SPV I')
  })
})

// ── Declare ────────────────────────────────────────────────────────────────────────────────────

describe('declare', () => {
  it('declares what was previewed: the date as distributionDate, the tiers and cash from the preview, available and reserve', async () => {
    const { fetcher, calls } = fakeFetcher({ status: 200, body: { distributionId: 'd1' } })
    const a = await declareAction(fetcher, previewed())
    expect(a).toEqual({ type: 'declareDone' })
    const b = calls[0].body
    expect(b.action).toBe('declare')
    expect(b.distributionDate).toBe(ASOF)
    expect(b.splitMethod).toBe('waterfall')
    expect(b.tiers).toEqual(PREVIEW.tiers)
    expect(b.tiers.contingencyReturn).toBe(10_000)
    expect(b.cash).toEqual(PREVIEW.cash)
    expect(b.character).toEqual(PREVIEW.suggestedCharacter)
    expect(b.available).toBe(2_000_000)
    expect(b.reserve).toBe(50_000)
    expect(b.lines).toEqual(PREVIEW.lines)
    expect(b.carryLines).toEqual(PREVIEW.carryLines)
    expect(b.description).toBe('Year one')
    expect(b.requestKey).toBe('key-1')
  })

  it('the preview asOf and the declared distributionDate are one value', async () => {
    const { fetcher, calls } = fakeFetcher({ status: 200, body: PREVIEW }, { status: 200, body: {} })
    const s0 = filled({ date: '2027-03-31' })
    const done = await previewAction(fetcher, s0.inputs)
    const s1 = proposalReducer(s0, done)
    await declareAction(fetcher, s1)
    expect(calls[1].body.distributionDate).toBe(calls[0].body.asOf)
  })

  it('reuses the request key on a retry, so a retried declaration posts once', async () => {
    const { fetcher, calls } = fakeFetcher(
      { status: 400, body: { error: 'The investor lines do not match the waterfall', code: 'WATERFALL_MISMATCH' } },
      { status: 200, body: PREVIEW },
      { status: 200, body: {} },
    )
    let s = previewed()
    s = proposalReducer(s, await declareAction(fetcher, s))
    s = proposalReducer(s, await previewAction(fetcher, s.inputs))
    s = proposalReducer(s, await declareAction(fetcher, s))
    expect(calls[0].body.requestKey).toBe('key-1')
    expect(calls[2].body.requestKey).toBe('key-1')
  })

  it('with a profit share the investor lines are locked: the route holds carry declarations to the waterfall to the cent', async () => {
    expect(PREVIEW.carryLines.some(l => l.amount > 0)).toBe(true)
    expect(linesEditable(PREVIEW)).toBe(false)
    const [a] = PREVIEW.lines
    const s = proposalReducer(previewed(), { type: 'editLine', lpEntityId: a.lpEntityId, value: String(a.amount + 100) })
    expect(s.edits).toBeNull()
    const html = form(s)
    expect(input(html, `wf-line-${a.lpEntityId}`)).toContain('readOnly=""')
    expect(html).toContain('data-lines="locked"')
    // Even if edits reached the action, it would not send them.
    const { fetcher, calls } = fakeFetcher()
    expect(await declareAction(fetcher, { ...previewed(), edits: { [a.lpEntityId]: '1' } })).toMatchObject({ type: 'refused' })
    expect(calls).toHaveLength(0)
  })

  it('without one, an edited line declares a manual split with no tiers, tied to available less reserve', async () => {
    // Pref and capital only: no profit, so no carry line, so the route runs only the cash check.
    const NO_CARRY = packPreview(400_000, 25_000, 10_000)
    expect(linesEditable(NO_CARRY)).toBe(true)
    const [a, b] = NO_CARRY.lines
    let s = proposalReducer(done(filled({ available: '400000', reserve: '25000', contingencyReturn: '10000' }), NO_CARRY), { type: 'editLine', lpEntityId: a.lpEntityId, value: String(a.amount + 100) })
    const { fetcher, calls } = fakeFetcher()
    expect(await declareAction(fetcher, s)).toMatchObject({ type: 'refused' })
    expect(calls).toHaveLength(0)
    s = proposalReducer(s, { type: 'editLine', lpEntityId: b.lpEntityId, value: String(Math.round((b.amount - 100) * 100) / 100) })
    const ok = fakeFetcher({ status: 200, body: {} })
    expect(await declareAction(ok.fetcher, s)).toEqual({ type: 'declareDone' })
    const body = ok.calls[0].body
    expect(body).toMatchObject({ splitMethod: 'manual', tiers: null, available: 400_000, reserve: 25_000 })
    // The preview's cash block still goes, so the contingency returned reaches the route.
    expect(body.cash).toEqual(NO_CARRY.cash)
    expect(body.cash.contingencyReturn).toBe(10_000)
    // What the route then checks (cashAmountMismatch): no positive carry line, and the lines total available − reserve.
    expect(body.carryLines.filter((l: { amount: number }) => l.amount > 0)).toEqual([])
    expect(body.lines.reduce((t: number, l: { amount: number }) => t + Math.round(l.amount * 100), 0)).toBe(37_500_000)
    expect(form(s)).toContain('will be declared as a manual split')
  })
})

// ── The stale-preview guard ────────────────────────────────────────────────────────────────────

describe('any input change invalidates the preview', () => {
  it('Declare is enabled on an unmodified preview', () => {
    const s = previewed()
    expect(canDeclare(s)).toBe(true)
    expect(disabled(form(s), 'declare')).toBe(false)
  })

  it('changing the date after a preview disables Declare until a new preview', () => {
    let s = proposalReducer(previewed(), { type: 'input', field: 'date', value: '2027-02-01' })
    expect(canDeclare(s)).toBe(false)
    const html = form(s)
    expect(disabled(html, 'declare')).toBe(true)
    expect(disabled(html, 'preview')).toBe(false)
    expect(html).toContain('data-stale="true"')
    s = done(s)
    expect(s.previewAsOf).toBe('2027-02-01')
    expect(canDeclare(s)).toBe(true)
  })

  it('an input changed while the preview is in flight leaves the reply stale', async () => {
    const { fetcher, calls } = fakeFetcher({ status: 200, body: PREVIEW })
    let s = proposalReducer(filled(), { type: 'previewStart' })
    const asked = s.inputs
    // The reserve moves from 50,000 to 100,000 before the reply for 50,000 lands.
    s = proposalReducer(s, { type: 'input', field: 'reserve', value: '100000' })
    s = proposalReducer(s, await previewAction(fetcher, asked))
    expect(calls[0].body.reserve).toBe(50_000)
    expect(s.stale).toBe(true)
    expect(canDeclare(s)).toBe(false)
    const html = form(s)
    expect(disabled(html, 'declare')).toBe(true)
    expect(disabled(html, 'preview')).toBe(false)
    expect(html).toContain('data-stale="true"')
    expect(await declareAction(fetcher, s)).toMatchObject({ type: 'refused' })
    expect(calls).toHaveLength(1)
  })

  it('so does one changed and changed back: the key, not the flag, decides', () => {
    let s = proposalReducer(filled(), { type: 'previewStart' })
    const key = previewKey(s.inputs)!
    s = proposalReducer(s, { type: 'input', field: 'reserve', value: '100000' })
    s = proposalReducer(s, { type: 'input', field: 'reserve', value: '50000' })
    s = proposalReducer(s, { type: 'previewDone', preview: PREVIEW, asOf: ASOF, key })
    expect(canDeclare(s)).toBe(true)
    s = proposalReducer(s, { type: 'input', field: 'available', value: '2,000,001' })
    expect(canDeclare(s)).toBe(false)
  })

  it.each(['available', 'reserve', 'contingencyReturn'] as const)('changing %s does too', field => {
    expect(canDeclare(proposalReducer(previewed(), { type: 'input', field, value: '1' }))).toBe(false)
  })

  it('the description does not', () => {
    expect(canDeclare(proposalReducer(previewed(), { type: 'input', field: 'description', value: 'Renamed' }))).toBe(true)
  })

  it('there is nothing to declare before a preview', () => {
    expect(disabled(form(filled()), 'declare')).toBe(true)
  })
})

// ── Refusals ───────────────────────────────────────────────────────────────────────────────────

describe('the route’s refusal codes', () => {
  it.each(['WATERFALL_MISMATCH', 'STATED_CASH_MISMATCH'])('%s says preview again and re-enables Preview, not Declare', async code => {
    const { fetcher } = fakeFetcher({ status: 400, body: { error: 'server words', code } })
    const s = proposalReducer(previewed(), await declareAction(fetcher, previewed()))
    expect(s.error).toEqual({ text: PREVIEW_AGAIN, previewAgain: true })
    const html = form(s)
    expect(html).toContain('The waterfall changed since you previewed; preview again.')
    expect(html).toContain('data-error="preview-again"')
    expect(disabled(html, 'preview')).toBe(false)
    expect(disabled(html, 'declare')).toBe(true)
  })

  it('RESERVE_REQUIRED targets the reserve field with the route’s message', async () => {
    const message = 'A reserve of at least 0 and less than the available cash is required'
    const { fetcher } = fakeFetcher({ status: 400, body: { error: message, code: 'RESERVE_REQUIRED' } })
    const s = proposalReducer(filled(), await previewAction(fetcher, filled().inputs))
    const html = form(s)
    expect(html).toContain(message)
    expect(input(html, 'wf-reserve')).toContain('aria-invalid="true"')
    expect(input(html, 'wf-reserve')).toContain('aria-describedby="wf-error"')
    expect(input(html, 'wf-available')).not.toContain('aria-invalid')
  })

  it('any other refusal is shown in its own words', async () => {
    const { fetcher } = fakeFetcher({ status: 400, body: { error: 'A valid distribution date is required' } })
    const s = proposalReducer(previewed(), await declareAction(fetcher, previewed()))
    expect(form(s)).toContain('A valid distribution date is required')
    expect(canDeclare(s)).toBe(true)
  })

  it('a dropped connection is a message, not a silent failure', async () => {
    const r = await send(async () => { throw new TypeError('Failed to fetch') }, '/api/accounting/distributions', 'POST', {})
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/Could not reach the server/)
  })
})

// ── The reserve default ────────────────────────────────────────────────────────────────────────

describe('the reserve is pre-filled from lastReserve', () => {
  it('with the last declared reserve', () => {
    const s = openProposal(25_000, ASOF, 'k')
    expect(s.inputs.reserve).toBe('25000')
    expect(input(form(s), 'wf-reserve')).toContain('value="25000"')
  })

  it('blank when there is none', () => {
    const s = openProposal(null, ASOF, 'k')
    expect(s.inputs.reserve).toBe('')
    expect(input(form(s), 'wf-reserve')).toContain('value=""')
  })

  it('the date opens on the given day', () => {
    expect(openProposal(null, ASOF, 'k').inputs.date).toBe(ASOF)
  })
})

// ── The identity ───────────────────────────────────────────────────────────────────────────────

describe('the preview’s identity', () => {
  it('contingency + pref + return of capital + profit to investors + profit share (+ manager ROC) = available − reserve, to the cent', () => {
    const t = PREVIEW.tiers
    // A year's 8% on 1,435,500 under 30E/360, all of the capital back, then a 70/30 split.
    expect(t.preferred).toBe(114_840)
    expect(t.contingencyReturn).toBe(10_000)
    expect(t.carry).toBeGreaterThan(0)
    const id = previewIdentity(PREVIEW)
    expect(id).toEqual({ sum: 1_950_000, target: 1_950_000, holds: true })
    const cents = Math.round((t.contingencyReturn ?? 0) * 100) + Math.round(t.preferred * 100) + Math.round(t.returnOfCapital * 100)
      + Math.round(t.profitToLP * 100) + Math.round(t.carry * 100) + Math.round((PREVIEW.cash?.managerRocShare ?? 0) * 100)
    expect(cents).toBe(195_000_000)
    expect(form(previewed())).toContain('data-identity="holds"')
  })

  it('holds for a distribution that only pays pref and capital', () => {
    const p = packPreview(400_000, 25_000, 10_000)
    expect(p.tiers.carry).toBe(0)
    expect(previewIdentity(p)).toEqual({ sum: 375_000, target: 375_000, holds: true })
  })

  it('a tampered tier breaks it, visibly', () => {
    const bad = { ...PREVIEW, tiers: { ...PREVIEW.tiers, preferred: PREVIEW.tiers.preferred + 0.01 } }
    expect(previewIdentity(bad).holds).toBe(false)
    const s = done(filled(), bad)
    const html = form(s)
    expect(html).toContain('data-identity="broken"')
    // …and Declare is off: the panel says not to declare it.
    expect(canDeclare(s)).toBe(false)
    expect(disabled(html, 'declare')).toBe(true)
  })
})

// ── gp_economics ───────────────────────────────────────────────────────────────────────────────

const HISTORY: HistoryRow[] = [{
  distributionId: 'd1', date: ASOF, description: 'Year one', total: 1_950_000, lpTotal: 1_950_000 - PREVIEW.tiers.toGP,
  carryTotal: PREVIEW.tiers.toGP, status: 'partial', reserve: 50_000, splitMethod: 'waterfall',
  tiers: { ...PREVIEW.tiers, cash: PREVIEW.cash },
  lines: [
    { role: 'lp', amount: 1_000_000, settled: 1_000_000 },
    { role: 'carry', amount: PREVIEW.tiers.toGP, settled: 1_234.56 },
  ],
}]

// A fund with the books, investors' capital and GPU economics switched on for members; the member
// is granted the books and investors' capital, and gp_economics or not.
const access = (gp: boolean | 'write', accounting: 'read' | 'write' = 'write'): ClientAccess => ({
  role: 'member',
  features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', lps: 'everyone', lp_tracking: 'everyone', gp_economics: 'everyone', gpu_fleet: 'everyone' } as FeatureVisibilityMap,
  grants: { lp_capital: 'write', accounting, ...(gp ? { gp_economics: gp === 'write' ? 'write' as const : 'read' as const } : {}) },
  defaults: {},
})
const page = (gp: boolean | 'write', accounting: 'read' | 'write' = 'write') => renderToStaticMarkup(
  <AccessProvider value={access(gp, accounting)}>
    <CurrencyProvider currency="USD"><WaterfallView vehicle="GPU SPV I" vehicleId="v1" /></CurrencyProvider>
  </AccessProvider>,
)

describe('the manager’s figures need gp_economics', () => {
  it('without it: no carry lines, no manager tier in the preview', () => {
    const html = form(previewed(), false)
    expect(html).not.toContain('data-region="carry-lines"')
    expect(html).not.toContain('data-tier="manager-profit-share"')
    expect(html).not.toContain('data-tier="manager-roc-share"')
    expect(html).not.toContain('GPU Manager LLC')
    expect(html).toContain('data-tier="profit-to-investors"')
    // The identity line names the investors' side only: no manager-inclusive total, no target.
    const t = PREVIEW.tiers
    const toInvestors = (Math.round((t.contingencyReturn ?? 0) * 100) + Math.round(t.preferred * 100) + Math.round(t.returnOfCapital * 100) + Math.round(t.profitToLP * 100)) / 100
    const line = html.match(/<p[^>]*data-identity="holds"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? ''
    expect(line).toContain(`= ${money(toInvestors)}`)
    expect(line).not.toContain(money(1_950_000))
    expect(line).not.toMatch(/manager/i)
    expect(line).toContain('It adds up')
  })

  it('with it: the carry lines and the manager tier', () => {
    const html = form(previewed(), true)
    expect(html).toContain('data-region="carry-lines"')
    expect(html).toContain('data-tier="manager-profit-share"')
    expect(html).toContain('GPU Manager LLC')
    expect(html).toContain(money(PREVIEW.tiers.carry))
  })

  it('the terms card renders only with it; declaring needs lp_capital write either way', () => {
    expect(page(false)).not.toContain('data-region="terms"')
    expect(page(true)).toContain('data-region="terms"')
    expect(page(false)).not.toContain('Needs write access to investors')
  })

  it('the history’s profit share columns and manager tiers render only with it', () => {
    const open = (gp: boolean) => renderToStaticMarkup(<DistributionHistory rows={HISTORY} seesCarry={gp} money={money} initiallyOpen={['d1']} />)
    const without = open(false)
    expect(without).toContain(`data-figure="total">${money(1_950_000)}`)
    expect(without).not.toContain('Profit share paid')
    expect(without).not.toContain('data-tier="manager-profit-share"')
    expect(without).not.toContain('data-tier="unreturned-after"')
    const withGp = open(true)
    expect(withGp).toContain(`data-figure="paid">${money(1_234.56)}`)
    expect(money(1_234.56)).not.toBe(money(PREVIEW.tiers.toGP))
    expect(withGp).toContain(`data-figure="declared">${money(PREVIEW.tiers.toGP)}`)
    expect(withGp).toContain('data-tier="manager-profit-share"')
    expect(withGp).toContain('data-tier="unreturned-after"')
  })

  it('day count labels', () => {
    expect(dayCountLabel('30_360')).toBe('30E/360')
    expect(dayCountLabel('act_365')).toBe('ACT/365')
  })
})

// ── History ────────────────────────────────────────────────────────────────────────────────────

describe('the history', () => {
  it('shows the returned contingency as a tier line when it is not zero', () => {
    const html = renderToStaticMarkup(<TierBreakdown row={HISTORY[0]} seesCarry={false} money={money} />)
    expect(html).toContain('Return of unspent contingency')
    expect(html).toContain(money(10_000))
    const none = { ...HISTORY[0], tiers: { ...HISTORY[0].tiers!, contingencyReturn: 0 } }
    expect(renderToStaticMarkup(<TierBreakdown row={none} seesCarry={false} money={money} />)).not.toContain('Return of unspent contingency')
  })

  it('a row with no tiers says how it was split', () => {
    const manual = { ...HISTORY[0], splitMethod: 'manual' as const, tiers: null }
    expect(renderToStaticMarkup(<TierBreakdown row={manual} seesCarry={false} money={money} />)).toContain('Manual split')
  })

  it('shows the reserve held back, and says what the totals cover', () => {
    const html = renderToStaticMarkup(<DistributionHistory rows={HISTORY} seesCarry money={money} />)
    expect(html).toContain(money(50_000))
    expect(html).toContain('In the 1 distribution shown')
    expect(html).toContain('drafts included')
  })
})

// ── The pref ledger and the position ───────────────────────────────────────────────────────────

const named = (rows: ReturnType<typeof prefLedger>): PrefLedgerRow[] =>
  rows.map(r => ({ ...r, perInvestor: r.perInvestor?.map(i => ({ ...i, name: NAMES[i.lpEntityId] })) }))
// The pack's year: contributions, a short distribution that carries pref forward, then a large one.
const LEDGER = named(prefLedger(
  cashWaterfallEvents(CONTRIBUTIONS, [{ date: '2026-07-01', amount: 20_000 }, { date: ASOF, amount: 1_950_000, contingencyReturn: 10_000 }], '9999-12-31'),
  cashWaterfallTerms(TERMS),
))

describe('the pref ledger', () => {
  it('totals the fixture rows: accrued and paid sum, carried forward is the closing balance', () => {
    const t = prefLedgerTotals(LEDGER)
    const sum = (f: (r: PrefLedgerRow) => number) => Math.round(LEDGER.reduce((s, r) => s + Math.round(f(r) * 100), 0)) / 100
    expect(t.accrued).toBe(sum(r => r.accrued))
    expect(t.paid).toBe(sum(r => r.paid))
    expect(t.carriedForward).toBe(LEDGER[LEDGER.length - 1].carriedForward)
    expect(Math.round((t.accrued - t.paid) * 100)).toBe(Math.round(t.carriedForward * 100))
    // The short July distribution left pref owed; it was carried forward, not compounded.
    expect(LEDGER.some(r => r.carriedForward > 0)).toBe(true)

    const html = renderToStaticMarkup(<PrefLedgerTable rows={LEDGER} money={money} initiallyOpen={[LEDGER.length - 1]} />)
    expect(html).toContain(`data-total="accrued">${money(t.accrued)}`)
    expect(html).toContain(`data-total="paid">${money(t.paid)}`)
    expect(html).toContain('Alder Partners')
  })

  it('a 400 renders the explanatory alert, not an error', () => {
    const html = renderToStaticMarkup(<PrefLedgerUnavailable message="The pref ledger is for a distributable-cash waterfall; this vehicle has other terms." />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('No preferred-return ledger for this vehicle')
    expect(html).toContain('this vehicle has other terms')
    expect(html).not.toContain('text-destructive')
  })

  it('without per-investor lines there is no position, and the tiles say why', () => {
    const bare = LEDGER.map(({ perInvestor: _drop, ...r }) => r)
    expect(positionFromLedger(bare, [])).toBeNull()
    const html = renderToStaticMarkup(<PositionTiles position={null} money={money} unavailable="The pref ledger has no per-investor lines" />)
    expect(html.match(/The pref ledger has no per-investor lines/g)).toHaveLength(7)
  })

  it('the position tiles come from the ledger and the history', () => {
    const p = positionFromLedger(LEDGER, [{ lpTotal: 20_000 }, { lpTotal: HISTORY[0].lpTotal }])!
    expect(p.contributed).toBe(1_435_500)
    expect(p.unreturned).toBe(0)
    expect(p.capitalReturned).toBe(1_435_500)
    expect(p.prefPaid).toBe(prefLedgerTotals(LEDGER).paid)
    expect(p.distributedToInvestors).toBe(Math.round((20_000 + HISTORY[0].lpTotal) * 100) / 100)
    expect(p.dpi).toBeCloseTo(p.distributedToInvestors / 1_435_500, 10)
    expect(unreturnedCapital(LEDGER.slice(0, 2))).toBe(1_435_500)
  })
})

// ── Fee terms ──────────────────────────────────────────────────────────────────────────────────

describe('edit fee terms', () => {
  it('PUTs gross revenue, the rate as a fraction, frequency, the payee and the dates', async () => {
    const r = feeTermsBody({ ratePct: '5', frequency: 'quarterly', payeeVehicleId: 'manco-1', effectiveFrom: '2026-01-01', effectiveTo: '', revenueSubtypes: null })
    expect(r).toEqual({ ok: true, body: { basis: 'gross_revenue', annualRate: 0.05, frequency: 'quarterly', payeeVehicleId: 'manco-1', effectiveFrom: '2026-01-01', effectiveTo: null } })
    const { fetcher, calls } = fakeFetcher({ status: 400, body: { error: 'effectiveFrom (YYYY-MM-DD) is required.' } })
    const sent = await send(vehicleFetcher('GPU SPV I', fetcher), '/api/accounting/fee-terms', 'PUT', r.ok && r.body)
    expect(calls[0].init?.method).toBe('PUT')
    expect(calls[0].body).toMatchObject({ basis: 'gross_revenue', annualRate: 0.05, group: 'GPU SPV I' })
    expect(sent).toEqual({ ok: false, status: 400, error: 'effectiveFrom (YYYY-MM-DD) is required.' })
  })

  it('sends only values the route accepts: its exported basis and frequency lists, a rate in [0, 1), YYYY-MM-DD dates', () => {
    // The PUT's checks are inline in the route; these are the lists and rules it applies.
    for (const frequency of ['monthly', 'quarterly'] as const) {
      const r = feeTermsBody({ ratePct: '5', frequency, payeeVehicleId: '', effectiveFrom: '2026-01-01', effectiveTo: '', revenueSubtypes: null })
      if (!r.ok) throw new Error(r.error)
      expect(FEE_BASES).toContain(r.body.basis)
      expect(FEE_FREQUENCIES).toContain(r.body.frequency)
      expect(r.body.annualRate).toBeGreaterThanOrEqual(0)
      expect(r.body.annualRate).toBeLessThan(1)
      expect(r.body.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(Object.keys(r.body).sort()).toEqual(['annualRate', 'basis', 'effectiveFrom', 'effectiveTo', 'frequency', 'payeeVehicleId'])
    }
  })

  it('saves the revenue subtypes back as read, so editing the rate keeps a custom fee base', () => {
    const terms = { basis: 'gross_revenue', annualRate: 0.05, frequency: 'monthly', revenueSubtypes: ['rental_revenue', 'other_revenue'], payeeVehicleId: null, effectiveFrom: '2026-01-01', effectiveTo: null }
    const f = { ...feeFormOf(terms), ratePct: '6' }
    const r = feeTermsBody(f)
    expect(r.ok && r.body).toMatchObject({ annualRate: 0.06, revenueSubtypes: ['rental_revenue', 'other_revenue'] })
    // Read without a list (no terms yet): none sent, and the route applies its default.
    const fresh = feeTermsBody({ ...feeFormOf(null), ratePct: '5', effectiveFrom: '2026-01-01' })
    expect(fresh.ok && 'revenueSubtypes' in fresh.body).toBe(false)
  })

  it('no payee is Due to manager (2100): null', () => {
    const r = feeTermsBody({ ratePct: '2.5%', frequency: 'monthly', payeeVehicleId: '', effectiveFrom: '2026-01-01', effectiveTo: '2030-12-31', revenueSubtypes: null })
    expect(r.ok && r.body).toMatchObject({ annualRate: 0.025, payeeVehicleId: null, effectiveTo: '2030-12-31' })
  })

  it('a blank rate is refused here rather than sent as 0', () => {
    expect(feeTermsBody({ ...feeFormOf(null), effectiveFrom: '2026-01-01' })).toMatchObject({ ok: false })
  })

  it('opens on the terms in force, and offers only the management companies as payees', () => {
    const f = feeFormOf({ basis: 'gross_revenue', annualRate: 0.05, frequency: 'monthly', payeeVehicleId: null, effectiveFrom: '2026-01-01', effectiveTo: null })
    expect(f).toEqual({ ratePct: '5', frequency: 'monthly', payeeVehicleId: '', effectiveFrom: '2026-01-01', effectiveTo: '', revenueSubtypes: null })
    const html = renderToStaticMarkup(<FeeTermsForm form={f} onChange={() => {}} mancos={[{ id: 'm1', name: 'Hemrock Manco' }]} error="The fee payee must be a management company in this fund." />)
    expect(html).toContain('Due to manager (2100)')
    expect(html).toContain('Hemrock Manco')
    expect(html).toContain('The fee payee must be a management company in this fund.')
  })
})

// ── Waterfall terms ────────────────────────────────────────────────────────────────────────────

describe('edit the waterfall terms', () => {
  const PACK_FORM: CashTermsForm = {
    prefPct: '8', dayCount: '30_360', investorsBeforePct: '100', investorsAfterPct: '70',
    recipients: [{ lpEntityId: 'mgr', pct: '100' }],
  }

  it('PUTs the pack terms: 8% pref, 30E/360, X = 100 and Y = 70 as rocLpShare 1 and carryRate 0.3', async () => {
    const r = cashTermsBody(PACK_FORM)
    if (!r.ok) throw new Error(r.error)
    expect(r.body).toEqual({
      kind: 'distributable_cash', prefRate: 0.08, prefDayCount: '30_360', prefBasis: 'unreturned',
      rocLpShare: 1, carryRate: 0.3, prefCompounds: false, catchupRate: 1,
      carryRecipients: [{ lpEntityId: 'mgr', pct: 100 }],
    })
    // The route's own rule for this kind accepts it.
    const b = r.body as any
    expect(validateCashTerms({
      prefRate: b.prefRate, dayCount: b.prefDayCount, rocLpShare: b.rocLpShare, carryRate: b.carryRate,
      recipients: b.carryRecipients, catchupRate: b.catchupRate, prefCompounds: b.prefCompounds, prefBasis: b.prefBasis,
    })).toBeNull()
    const { fetcher, calls } = fakeFetcher({ status: 200, body: { ok: true } })
    await send(vehicleFetcher('GPU SPV I', fetcher), '/api/accounting/waterfall-terms', 'PUT', r.body)
    expect(calls[0].path).toBe('/api/accounting/waterfall-terms?group=GPU%20SPV%20I')
    expect(calls[0].init?.method).toBe('PUT')
    expect(calls[0].body).toMatchObject({ kind: 'distributable_cash', rocLpShare: 1, carryRate: 0.3, group: 'GPU SPV I' })
  })

  it('opens on the stored terms, and shows the manager\u2019s side of each split as it is typed', () => {
    const f = cashTermsFormOf({ kind: 'distributable_cash', carryRate: 0.3, prefRate: 0.08, recipients: [{ lpEntityId: 'mgr', pct: 100 }], prefDayCount: 'act_365', rocLpShare: 0.9 })
    expect(f).toEqual({ prefPct: '8', dayCount: 'act_365', investorsBeforePct: '90', investorsAfterPct: '70', recipients: [{ lpEntityId: 'mgr', pct: '100' }] })
    expect(managerPct('90')).toBe(10)
    expect(managerPct('70')).toBe(30)
    const html = renderToStaticMarkup(<CashTermsEditor form={f} onChange={() => {}} candidates={[{ lpEntityId: 'mgr', name: 'GPU Manager LLC', partnerClass: 'gp' }]} error={null} />)
    expect(html).toContain('data-derived="manager-before">10%')
    expect(html).toContain('data-derived="manager-after">30%')
    expect(html).toContain('GPU Manager LLC (GP)')
    expect(html).toContain('<option value="30_360">30E/360</option>')
  })

  it.each([
    ['investorsBeforePct', '-1'], ['investorsBeforePct', '100.5'], ['investorsAfterPct', '-0.01'], ['investorsAfterPct', '101'],
  ] as const)('refuses %s = %s on the page', (field, value) => {
    expect(cashTermsBody({ ...PACK_FORM, [field]: value })).toMatchObject({ ok: false, field })
    expect(managerPct(value)).toBeNull()
  })

  it('accepts the bounds themselves; the route decides the rest', () => {
    expect(cashTermsBody({ ...PACK_FORM, investorsBeforePct: '0' }).ok).toBe(true)
    expect(cashTermsBody({ ...PACK_FORM, investorsAfterPct: '100' }).ok).toBe(true)
  })

  it('a 400 from the route is shown in its own words', async () => {
    const message = 'Profit-share recipient percentages must total 100 (they total 90).'
    const { fetcher } = fakeFetcher({ status: 400, body: { error: message } })
    const r = await send(fetcher, '/api/accounting/waterfall-terms', 'PUT', {})
    expect(r).toEqual({ ok: false, status: 400, error: message })
    const html = renderToStaticMarkup(<CashTermsEditor form={PACK_FORM} onChange={() => {}} candidates={[]} error={{ text: !r.ok ? r.error : '' }} />)
    expect(html).toContain(message)
    expect(html).toContain('role="alert"')
  })

  it('the Edit terms button needs gp_economics write and accounting write', () => {
    const button = /data-action="edit-waterfall-terms"/
    expect(page(false)).not.toMatch(button)
    expect(page(true)).not.toMatch(button)
    expect(page('write', 'read')).not.toMatch(button)
    expect(page('write')).toMatch(button)
  })
})

// ── Q8 ─────────────────────────────────────────────────────────────────────────────────────────

describe('no accrued profit share anywhere on the page (Q8)', () => {
  const files = ['waterfall-view.tsx', 'propose-distribution.tsx', 'distribution-history.tsx', 'waterfall-position.tsx', 'waterfall-terms-card.tsx', 'waterfall-terms-dialog.tsx', 'pref-ledger-table.tsx']
  it.each(files)('%s names no accrued or hypothetical carry', f => {
    const src = readFileSync(join(process.cwd(), 'components/gpu', f), 'utf8')
    expect(src).not.toMatch(/accrued (carry|profit share)|carry accrued|carry at NAV|hypothetical liquidation/i)
  })
})
