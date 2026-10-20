import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * ── GPU fleet (P5) ── Revenue & payouts entry, posting, payout matching and fleet KPIs (P5-4).
 *
 * Rendered statically, as the repo's other component tests are: the tables and gated buttons from
 * props, and the requests through the same builders the page calls, with a fake fetcher. The entry
 * rows are run through the route's own parser (parseManualRows), and the KPI fixture through P3's
 * computeKpis, so a field the page names and the server does not read fails here.
 */

import { CurrencyProvider, formatCurrencyFull, formatCurrencyPrice } from '@/components/currency-context'
import { EntryTable, ImportSummary } from '@/components/gpu/revenue-entry'
import { EarningStatusBadge, EarningsTable, ReversalList, POST_HINT_NO_BOOKS, POST_HINT_NO_FLEET, postHint } from '@/components/gpu/revenue-earnings'
import { PayoutsTable, TieOutCard, AutoPostPlaceholder } from '@/components/gpu/revenue-payouts'
import { AssetKpis, LtmTiles, PublishPlaceholder } from '@/components/gpu/fleet-kpis'
import {
  combineLtm, derived, entryRowFor, groupByPeriod, importCsv, lastTwelveMonths, manualRowsBody, matchPayout, payoutBody, postEarnings,
  previousMonth, recordPayout, stageRows, STAGED_CAPTION,
  type EarningView, type EntryRow, type FleetKpis, type PayoutView, type ReceivableTieOut,
} from '@/components/gpu/revenue-api'
import type { Fetcher } from '@/components/gpu/fleet-api'
import { vehicleFetcher } from '@/components/gpu/waterfall-api'
import { parseManualRows, parseEarningsCsv } from '@/lib/gpu/ops/parse'
import { EARNING_STATUSES } from '@/lib/gpu/ops/types'
import { computeKpis, ltm as ltmOf, type KpiAsset, type KpiEarning } from '@/lib/gpu/kpis'

const money = (n: number) => formatCurrencyFull(n, 'USD')
const inUsd = (node: React.ReactElement) => renderToStaticMarkup(<CurrencyProvider currency="USD">{node}</CurrencyProvider>)

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

// September 2026: 30 days, so an 8-GPU server has 8 × 24 × 30 = 5,760 GPU-hours.
const SEPT = { start: '2026-09-01', end: '2026-09-30' }
const server = (id: string, over: Partial<EntryRow> = {}): EntryRow => ({ ...entryRowFor({ id, name: `H200 #${id}`, gpu_count: 8 }), ...over })

// ── The entry form ─────────────────────────────────────────────────────────────────────────────

describe('the entry rows', () => {
  it('build bodies the route’s own parser accepts: hours, utilization, fee defaulted, net worked out', () => {
    const rows = [
      server('1', { rentedHours: '4320', gross: '8,640', fee: '864', net: '7776', downtimeHours: '12' }),
      server('2', { basis: 'utilization', utilizationPct: '75', gross: '8640', fee: '864' }),
      server('3', { rentedHours: '4320', gross: '8640' }),
    ]
    const r = manualRowsBody(SEPT, rows)
    if (!r.ok) throw new Error(r.errors.join('; '))
    expect(r.rows).toEqual([
      { assetId: '1', period_start: '2026-09-01', period_end: '2026-09-30', rented_hours: 4320, gross: 8640, fee: 864, net: 7776, downtime_hours: 12 },
      { assetId: '2', period_start: '2026-09-01', period_end: '2026-09-30', utilization_pct: 75, gross: 8640, fee: 864, net: 7776 },
      { assetId: '3', period_start: '2026-09-01', period_end: '2026-09-30', rented_hours: 4320, gross: 8640, fee: 0, net: 8640 },
    ])
    const parsed = parseManualRows(r.rows)
    expect(parsed.errors).toEqual([])
    expect(parsed.rows.map(p => [p.assetRef, p.rentedHours, p.utilizationPct, p.fee, p.net])).toEqual([
      ['1', 4320, null, 864, 7776], ['2', null, 75, 864, 7776], ['3', 4320, null, 0, 8640],
    ])
  })

  it('send nothing for a server left empty', () => {
    const r = manualRowsBody(SEPT, [server('1', { rentedHours: '10', gross: '20' }), server('2')])
    expect(r.ok && r.rows.map(x => x.assetId)).toEqual(['1'])
    expect(manualRowsBody(SEPT, [server('1'), server('2')])).toMatchObject({ ok: false })
  })

  it.each([
    ['both hours and utilization', { rentedHours: '10', utilizationPct: '5', gross: '20' }, 'exactly one'],
    ['neither', { gross: '20' }, 'exactly one'],
    ['gross − fee ≠ net', { rentedHours: '10', gross: '100', fee: '10', net: '91' }, 'not net 91.00'],
    ['a negative figure', { rentedHours: '-1', gross: '20' }, 'rented hours'],
    ['fee above gross', { rentedHours: '10', gross: '10', fee: '11' }, 'fee is more than gross'],
    ['utilization over 100', { basis: 'utilization' as const, utilizationPct: '101', gross: '1' }, 'more than 100%'],
  ])('refuse %s on the page, before any request', async (_label, over, message) => {
    const rows = [server('1', over)]
    const r = manualRowsBody(SEPT, rows)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.errors.join(' ')).toContain(message)
    const { fetcher, calls } = fakeFetcher()
    expect(await stageRows(fetcher, SEPT, rows)).toMatchObject({ ok: false })
    expect(calls).toHaveLength(0)
  })

  it('stage through the import route as { rows }, the vehicle pinned', async () => {
    const { fetcher, calls } = fakeFetcher({ status: 200, body: { imported: 1, skipped: 0, needsReview: 0, skippedRows: [], errors: [], runId: 'r', staged: [{ id: 'e1', status: 'staged' }] } })
    const r = await stageRows(vehicleFetcher('GPU SPV I', fetcher), SEPT, [server('1', { rentedHours: '4320', gross: '8640' })])
    expect(r.ok).toBe(true)
    expect(calls[0].path).toBe('/api/fleet/ops/import?group=GPU%20SPV%20I')
    expect(calls[0].body).toMatchObject({ group: 'GPU SPV I', rows: [{ assetId: '1', rented_hours: 4320 }] })
  })

  it('show the figure not typed, derived from GPUs × 24 × days as the import does', () => {
    expect(derived(server('1', { rentedHours: '4320' }), SEPT.start, SEPT.end)).toEqual({ rentedHours: 4320, utilizationPct: 75 })
    expect(derived(server('1', { basis: 'utilization', utilizationPct: '75' }), SEPT.start, SEPT.end)).toEqual({ utilizationPct: 75, rentedHours: 4320 })
    const html = renderToStaticMarkup(<EntryTable period={SEPT} rows={[server('1', { rentedHours: '4320' })]} onPeriod={() => {}} onRow={() => {}} />)
    expect(html).toMatch(/data-derived="utilization">75</)
  })

  it('default to last calendar month, and the table to the last twelve', () => {
    expect(previousMonth('2026-10-20')).toEqual({ start: '2026-09-01', end: '2026-09-30' })
    expect(previousMonth('2026-01-05')).toEqual({ start: '2025-12-01', end: '2025-12-31' })
    expect(lastTwelveMonths('2026-10-20')).toEqual({ from: '2025-11-01', to: '2026-10-31' })
  })
})

describe('a CSV paste', () => {
  it('goes to the route as typed, { csv }, and the route’s parser reads it', async () => {
    const csv = 'asset,period_start,period_end,rented_hours,utilization_pct,gross,fee,net,downtime_hours,note\nH200 #1,2026-09-01,2026-09-30,4320,,8640,864,7776,0,'
    const { fetcher, calls } = fakeFetcher({ status: 200, body: { imported: 1, skipped: 0, needsReview: 0, skippedRows: [], errors: [], runId: 'r', staged: [] } })
    await importCsv(vehicleFetcher('GPU SPV I', fetcher), csv)
    expect(calls[0].body).toEqual({ csv, group: 'GPU SPV I' })
    expect(parseEarningsCsv(csv).errors).toEqual([])
  })

  it('reports what was staged, skipped and why, and what matched no server', () => {
    const html = renderToStaticMarkup(<ImportSummary result={{
      imported: 2, skipped: 1, needsReview: 1, skippedRows: ['Row 3: H200 #1 2026-09-01..2026-09-30 is already entered'], errors: [],
      runId: 'r', staged: [{ id: 'a', status: 'staged' }, { id: 'b', status: 'unmatched' }],
    }} />)
    expect(html).toContain('already entered')
    expect(html).toContain('1 matched no server')
    expect(html).toContain('replace a posted period')
  })
})

// ── Posting ────────────────────────────────────────────────────────────────────────────────────

const earning = (id: string, over: Partial<EarningView> = {}): EarningView => ({
  id, runId: 'r', assetId: id, assetName: `H200 #${id}`, assetRef: `H200 #${id}`, periodStart: SEPT.start, periodEnd: SEPT.end,
  gpuHoursRented: 4320, utilizationPct: 75, gross: 8640, fee: 864, net: 7776, downtimeHours: 0, note: null, currency: 'USD',
  status: 'staged', supersedesId: null, entryId: null, ...over,
})

const table = (props: Partial<Parameters<typeof EarningsTable>[0]> = {}) => renderToStaticMarkup(
  <EarningsTable rows={[earning('1'), earning('2', { status: 'posted', entryId: 'je' })]} money={money} selected={new Set(['1'])} onToggle={() => {}}
    canWriteFleet canBook busy={null} onPost={() => {}} onIgnore={() => {}} {...props} />,
)
const button = (html: string, action: string) => html.match(new RegExp(`<button[^>]*data-action="${action}"[^>]*>`))?.[0] ?? ''
const isDisabled = (b: string) => /\sdisabled=""/.test(b)

describe('posting', () => {
  it('Post is disabled without Accounting write, with the reason; with it, enabled', () => {
    expect(isDisabled(button(table({ canBook: false }), 'post'))).toBe(true)
    expect(table({ canBook: false })).toContain(POST_HINT_NO_BOOKS)
    expect(isDisabled(button(table({ canWriteFleet: false }), 'post'))).toBe(true)
    expect(postHint(false, true)).toBe(POST_HINT_NO_FLEET)
    expect(isDisabled(button(table(), 'post'))).toBe(false)
  })

  it('Post needs staged rows selected; Ignore takes staged or unmatched; fleet write gates Ignore', () => {
    expect(isDisabled(button(table({ selected: new Set() }), 'post'))).toBe(true)
    const unmatched = table({ rows: [earning('u', { status: 'unmatched', assetId: null, assetName: null, assetRef: 'H2OO' })], selected: new Set(['u']) })
    expect(isDisabled(button(unmatched, 'post'))).toBe(true)
    expect(isDisabled(button(unmatched, 'ignore'))).toBe(false)
    expect(unmatched).toContain('Re-enter it under the server')
    expect(isDisabled(button(table({ canWriteFleet: false }), 'ignore'))).toBe(true)
  })

  it('a needsReversal reply lists the posted entries, and the re-send carries confirmReversal: true', async () => {
    const needs = { needsReversal: [{ id: 'new', supersedesId: 'old', entryId: 'je-old', entryDate: '2026-09-30' }] }
    const { fetcher, calls } = fakeFetcher({ status: 200, body: needs }, { status: 200, body: { posted: [{ id: 'new', entryId: 'je-new' }], reversed: [{ id: 'old', reversalId: 'rev' }] } })
    const first = await postEarnings(fetcher, ['new'])
    expect(calls[0].body).toEqual({ action: 'post', ids: ['new'] })
    if (!first.ok || !('needsReversal' in first.data)) throw new Error('expected needsReversal')
    const rows = [earning('new', { supersedesId: 'old' }), earning('old', { status: 'posted', net: 7000, entryId: 'je-old' })]
    const html = renderToStaticMarkup(<ReversalList entries={first.data.needsReversal} rows={rows} money={money} />)
    expect(html).toContain('data-reversal="old"')
    expect(html).toContain('2026-09-30')
    expect(html).toContain(money(7000))
    await postEarnings(fetcher, ['new'], true)
    expect(calls[1].body).toEqual({ action: 'post', ids: ['new'], confirmReversal: true })
  })

  it('a 403 from the route is shown in its own words', async () => {
    const message = 'Posting revenue needs write access to Fund accounting.'
    const { fetcher } = fakeFetcher({ status: 403, body: { error: message } })
    expect(await postEarnings(fetcher, ['1'])).toEqual({ ok: false, status: 403, error: message })
  })

  it('every status has a badge; posting and reversing render as in progress', () => {
    for (const s of EARNING_STATUSES) {
      const html = renderToStaticMarkup(<EarningStatusBadge status={s} />)
      expect(html, s).toContain(`data-status="${s}"`)
      expect(html, s).not.toContain(`>${s}<`)
      expect(html.includes('aria-busy="true"'), s).toBe(s === 'posting' || s === 'reversing')
    }
    expect(renderToStaticMarkup(<EarningStatusBadge status="staged" />)).toContain('text-info')
    expect(renderToStaticMarkup(<EarningStatusBadge status="unmatched" />)).toContain('text-warning')
    expect(renderToStaticMarkup(<EarningStatusBadge status="posted" />)).toContain('text-success')
    // A row being posted or reversed cannot be selected.
    expect(table({ rows: [earning('p', { status: 'posting' })], selected: new Set() })).not.toMatch(/type="checkbox"/)
  })

  it('groups by period, newest first, then server; a reversed row links to its replacement', () => {
    const rows = [earning('a', { periodStart: '2026-09-01', periodEnd: '2026-09-30' }), earning('b', { periodStart: '2026-08-01', periodEnd: '2026-08-31' })]
    expect(groupByPeriod(rows).map(g => g.period)).toEqual(['2026-09-01..2026-09-30', '2026-08-01..2026-08-31'])
    const html = table({ rows: [earning('new', { supersedesId: 'old' }), earning('old', { status: 'reversed' })], selected: new Set() })
    expect(html).toContain('href="#earning-new"')
  })
})

// ── Payouts ────────────────────────────────────────────────────────────────────────────────────

const PAYOUT: PayoutView = {
  id: 'p1', payoutDate: '2026-10-05', amount: 23_328, reference: 'PO-77', note: null, status: 'expected', bankTransactionId: null, entryId: null,
  candidates: [{ id: 't1', txnDate: '2026-10-06', amount: 23_328, description: 'MARKETPLACE PAYOUT', status: 'unmatched' }],
}

describe('payouts', () => {
  it('match sends { action: match, payoutId, txnId }; record sends the date and amount', async () => {
    const { fetcher, calls } = fakeFetcher({ status: 200, body: { payoutId: 'p1', entryId: 'je' } }, { status: 200, body: { payout: {} } })
    await matchPayout(fetcher, 'p1', 't1')
    expect(calls[0].body).toEqual({ action: 'match', payoutId: 'p1', txnId: 't1' })
    const b = payoutBody({ date: '2026-10-05', amount: '23,328', reference: ' PO-77 ', note: '' })
    if (!b.ok) throw new Error(b.error)
    await recordPayout(fetcher, b.body)
    expect(calls[1].body).toEqual({ action: 'record', date: '2026-10-05', amount: 23_328, reference: 'PO-77' })
    expect(payoutBody({ date: '', amount: '1', reference: '', note: '' })).toMatchObject({ ok: false })
    expect(payoutBody({ date: '2026-10-05', amount: '0', reference: '', note: '' })).toMatchObject({ ok: false })
  })

  it('Match needs Accounting write as well as the fleet', () => {
    const render = (canMatch: boolean) => renderToStaticMarkup(
      <PayoutsTable payouts={[PAYOUT]} money={money} canMatch={canMatch} choice={{ p1: 't1' }} onChoose={() => {}} matching={null} onMatch={() => {}} />,
    )
    expect(isDisabled(button(render(false), 'match'))).toBe(true)
    expect(isDisabled(button(render(true), 'match'))).toBe(false)
    expect(render(true)).toContain('MARKETPLACE PAYOUT')
  })

  const tie = (difference: number): ReceivableTieOut => ({ asOf: '2026-10-20', ledger1150: 23_328 + difference, postedNet: 23_328, matchedPayouts: 0, expected: 23_328, difference })

  it('the tie-out shows a non-zero difference in the warning token, and a zero one as tied out', () => {
    const off = renderToStaticMarkup(<TieOutCard tie={tie(150)} money={money} />)
    const dd = off.match(/<dd[^>]*data-off="true"[^>]*>([^<]*)</)
    expect(dd?.[0]).toContain('bg-warning-subtle')
    expect(dd?.[0]).toContain('text-warning')
    expect(dd?.[1]).toBe(money(150))
    expect(off).toContain('The close check flags this')
    const ok = renderToStaticMarkup(<TieOutCard tie={tie(0)} money={money} />)
    expect(ok).not.toContain('bg-warning-subtle')
    expect(ok).toContain('Ties out')
  })

  it('the auto-post toggle is a disabled placeholder until the settings route is on main', () => {
    const html = renderToStaticMarkup(<AutoPostPlaceholder />)
    expect(html).toContain('data-placeholder="auto-post"')
    expect(html).toMatch(/<button[^>]*disabled=""/)
  })
})

// ── KPIs ───────────────────────────────────────────────────────────────────────────────────────

// P3's fixture: 3 servers × 8 GPUs, September 2026 (720 h): 12,960 rented, $25,920 gross.
const kAsset = (id: string): KpiAsset => ({ id, name: `H200 #${id}`, gpu_count: 8, in_service_date: '2026-01-01', disposed_on: null, type_code: 'h200' })
const kEarning = (asset_id: string, status = 'posted'): KpiEarning => ({
  asset_id, period_end: '2026-09-30', status, gpu_hours_rented: 4320, gross: 8640, marketplace_fee: 864, net: 7776, downtime_hours: 0,
})
const month = (status = 'posted') => computeKpis({ assets: ['1', '2', '3'].map(kAsset), earnings: ['1', '2', '3'].map(id => kEarning(id, status)), month: '2026-09' })
const reply = (status = 'posted'): FleetKpis => { const m = month(status); return { ...m, ltm: ltmOf([m.fleet]) } }

describe('fleet KPIs', () => {
  it('24 GPUs × 720 h, 12,960 rented → 75.0 %, $25,920 gross → $2.00 per GPU-hour', () => {
    const k = reply()
    expect(k.fleet).toMatchObject({ gpuCount: 24, availableHours: 17_280, rentedHours: 12_960, utilizationPct: 75, grossRevenue: 25_920, realizedRate: 2 })
    const html = inUsd(<AssetKpis kpis={k} assetId="1" />)
    expect(html).toContain('75.0%')
    expect(html).toContain(`${formatCurrencyPrice(2, 'USD')}/GPU-hr`)
    expect(html).not.toContain(STAGED_CAPTION)
  })

  it('every tile that counts staged rows says so', () => {
    const html = inUsd(<AssetKpis kpis={reply('staged')} assetId="1" />)
    expect(html).toContain(STAGED_CAPTION)
    const tiles = inUsd(<LtmTiles ltm={reply('staged').ltm} base="Last 12 months" />)
    expect(tiles).toContain(`Last 12 months; ${STAGED_CAPTION}`)
    expect(tiles).toContain(formatCurrencyFull(25_920, 'USD'))
    expect(inUsd(<LtmTiles ltm={reply().ltm} base="Last 12 months" />)).not.toContain(STAGED_CAPTION)
  })

  it('a refusal is shown on the tiles, never a zero', () => {
    const html = inUsd(<LtmTiles ltm={null} error="Vehicle not found" />)
    expect(html).toContain('Vehicle not found')
    expect(html).not.toContain('$0')
  })

  it('several vehicles combine by summed hours, not averaged percentages', () => {
    const a = { ...reply().ltm, availableHours: 1000, rentedHours: 900, grossRevenue: 100, utilizationPct: 90 }
    const b = { ...reply().ltm, availableHours: 3000, rentedHours: 300, grossRevenue: 50, utilizationPct: 10, includesStaged: true }
    expect(combineLtm([a, b])).toEqual({ grossRevenue: 150, utilizationPct: 30, includesStaged: true })
  })

  it('Publish is a disabled placeholder until P3 PR B is on main', () => {
    expect(renderToStaticMarkup(<PublishPlaceholder />)).toMatch(/<button[^>]*disabled=""[^>]*>Publish month to metrics/)
  })
})
