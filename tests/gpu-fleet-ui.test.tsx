import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { useState } from 'react'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * ── GPU fleet (P5) ── The fleet register, asset detail and the requests behind them (P5-2).
 *
 * Rendered statically, as the repo's other component tests are: the tables and their gated buttons
 * from props, and the requests through the same builders and fetch wrapper the dialogs call, with a
 * fake fetcher. The bodies are also run through the routes' own parsers, so a field the UI names and
 * the route does not read fails here rather than in a browser.
 */

import { CurrencyProvider, formatCurrencyFull } from '@/components/currency-context'
import { RegisterTable, ContractsTable } from '@/components/gpu/fleet-register'
import { CapexEventsTable, ValuationCard } from '@/components/gpu/asset-detail'
import { CapexDialog, useCapexSubmitter, whileOpen } from '@/components/gpu/fleet-dialogs'
import { ErrorAlert, asOfCommit } from '@/components/gpu/fleet-ui'
import { ZERO_TOTALS, fleetTotals, isOffBooks, valuationDate, offBooksLabel, offersBookedActions, statusMoves, todayIso, type ValuedAsset } from '@/components/gpu/fleet-math'
import { FleetOverviewView } from '@/components/gpu/fleet-overview'
import {
  EMPTY_ASSET_FORM, EMPTY_CONTRACT_FORM, assetBody, assetFormError, assetFormOf, assetPatch, disposeBody, validAmount, capexSubmitter, contractBody, endContractBody, eventBody,
  eventFormError, fleetPaths, getAsset, listAssets, listVehicleAssets, localToUtc, mapBounded, nowLocalInput, rollBody, send, statusBody, utcToLocalLabel, type Fetcher,
} from '@/components/gpu/fleet-api'
import { parseAssetInput } from '@/lib/gpu/assets'
import { parseContractInput } from '@/lib/gpu/opex'
import type { DatacenterContractRow } from '@/lib/gpu/types'

const money = (n: number) => formatCurrencyFull(n, 'USD')

const AS_OF = '2026-12-31'

/**
 * A register row as GET /api/fleet/assets?as_of returns it: the row plus the server's valuation. The
 * valuation fields are fixture values, deliberately not derivable from the row, so a test passes only
 * if the page shows what the server sent rather than recomputing it.
 */
const asset = (over: Partial<ValuedAsset>): ValuedAsset => ({
  id: 'a', fund_id: 'f', vehicle_id: 'v', asset_type_id: null, name: 'Server', serials: [], vendor_id: null,
  status: 'in_service', gpu_count: 8, hardware_cost: 0, purchase_date: '2026-01-01', in_service_date: '2026-01-01',
  useful_life_months: 60, salvage_value: 0, depreciation_convention: 'full_month', tax_method: 'book', tax_bonus_pct: 0,
  tax_life_years: null, insurance_basis: null, datacenter_contract_id: null, purchase_entry_id: 'je', disposed_on: null,
  disposal_proceeds: null, disposal_entry_id: null, notes: null,
  basis: 0, capitalized_costs: 0, accumulated_book: 0, nbv_book: 0, accumulated_tax: 0, nbv_tax: 0,
  valuation_as_of: AS_OF, capex_events: [], on_books_as_of: true, ...over,
})

// The pack's three servers, with the server's valuation as of 31 December 2026 (book after 12 months
// on the plan; the H200 on bonus for tax). Figures as the route reports them.
const PACK = [
  asset({ id: 'h200', name: 'H200 NVL', hardware_cost: 335_000, basis: 335_000, accumulated_book: 60_300, nbv_book: 274_700,
    tax_method: 'bonus', accumulated_tax: 214_400, nbv_tax: 120_600 }),
  asset({ id: 'b200', name: 'B200', hardware_cost: 410_000, basis: 410_000, accumulated_book: 73_800, nbv_book: 336_200,
    accumulated_tax: 73_800, nbv_tax: 336_200 }),
  asset({ id: 'b300', name: 'B300', hardware_cost: 560_000, basis: 572_000, capitalized_costs: 12_000, accumulated_book: 100_950,
    nbv_book: 471_050, accumulated_tax: 100_950, nbv_tax: 471_050,
    capex_events: [{ month: '2026-03', amount: 12_000, source_ref: 'gpu-asset:b300:capex:inv-881', posted_at: '2026-03-14T15:20:00Z' }] }),
]

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

const register = (props: Partial<Parameters<typeof RegisterTable>[0]> = {}) => renderToStaticMarkup(
  <CurrencyProvider currency="USD">
    <RegisterTable
      assets={PACK} types={[]} contracts={[]} vehicleId="v1" canWriteFleet canBook
      onPurchase={() => {}} onDispose={() => {}} onDelete={() => {}} onMove={() => {}}
      {...props}
    />
  </CurrencyProvider>,
)

/** The <button> whose text is `label` in the row of asset `id`. */
const button = (html: string, id: string, label: string) => {
  const row = html.match(new RegExp(`<tr[^>]*data-asset="${id}"[\\s\\S]*?</tr>`))?.[0] ?? ''
  return row.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0] ?? null
}

describe('the fleet register', () => {
  /** The cell `col` of asset `id`'s row, by its data attribute. */
  const cell = (html: string, id: string, col: string) =>
    html.match(new RegExp(`data-asset="${id}"[\\s\\S]*?data-col="${col}" data-value="([^"]*)"`))?.[1]

  it('shows each server\u2019s book and tax figures exactly as the server reports them', () => {
    const html = register()
    for (const a of PACK) {
      expect(html).toContain(a.name)
      expect(cell(html, a.id, 'basis'), a.id).toBe(String(a.basis))
      expect(cell(html, a.id, 'accumulated_book'), a.id).toBe(String(a.accumulated_book))
      expect(cell(html, a.id, 'nbv_book'), a.id).toBe(String(a.nbv_book))
      expect(cell(html, a.id, 'accumulated_tax'), a.id).toBe(String(a.accumulated_tax))
      expect(cell(html, a.id, 'nbv_tax'), a.id).toBe(String(a.nbv_tax))
      expect(html).toContain(money(a.nbv_book))
    }
  })

  it('heads the second pair Tax book and says what date the figures are valued as of', () => {
    const html = register()
    expect(html).toMatch(/>Book<\/th>[\s\S]*?>Tax book<\/th>/)
    expect(html).toContain(`data-valuation-as-of="${AS_OF}"`)
    expect(html).toContain('Valued as of')
  })

  it('totals the server\u2019s figures: GPUs, basis, book and tax', () => {
    const html = register()
    expect(html).toMatch(/data-total="gpus"[^>]*>24</)
    expect(html).toContain(`data-total="basis">${money(1_317_000)}`)
    expect(html).toContain(`data-total="accumulated_book">${money(235_050)}`)
    expect(html).toContain(`data-total="nbv_book">${money(1_081_950)}`)
    expect(html).toContain(`data-total="accumulated_tax">${money(389_150)}`)
    expect(html).toContain(`data-total="nbv_tax">${money(927_850)}`)
    expect(fleetTotals(PACK)).toEqual({
      assets: 3, gpus: 24, basis: 1_317_000, planned: 0, accumulatedBook: 235_050, nbvBook: 1_081_950,
      accumulatedTax: 389_150, nbvTax: 927_850, inService: 3,
    })
  })

  it('leaves a disposed server out of the totals and shows it no book value', () => {
    const fleet = [...PACK, asset({ id: 'old', name: 'Old', hardware_cost: 100_000, basis: 100_000, status: 'disposed', disposed_on: '2026-06-30' })]
    expect(fleetTotals(fleet)).toMatchObject({ assets: 3, gpus: 24, basis: 1_317_000 })
    expect(cell(register({ assets: fleet }), 'old', 'nbv_book')).toBe('')
  })

  describe('an asset disposed of on 2026-06-30 is judged at the valuation date, not by its status today', () => {
    // Its status is disposed now; the server values it at each date by disposed_on <= as_of.
    const sold = (asOf: string, nbvBook: number, nbvTax: number) => asset({
      id: 'sold', name: 'Sold H100', status: 'disposed', disposed_on: '2026-06-30', hardware_cost: 300_000, basis: 300_000,
      accumulated_book: 300_000 - nbvBook, nbv_book: nbvBook, accumulated_tax: 300_000 - nbvTax, nbv_tax: nbvTax, valuation_as_of: asOf,
    })
    const atDate = (asOf: string, a: ValuedAsset) => PACK.map(p => ({ ...p, valuation_as_of: asOf })).concat(a)

    it('before (2026-03-31): included, with its historical NBV, in the row and the totals', () => {
      const a = sold('2026-03-31', 285_000, 240_000)
      const html = register({ assets: atDate('2026-03-31', a) })
      expect(cell(html, 'sold', 'nbv_book')).toBe('285000')
      expect(cell(html, 'sold', 'nbv_tax')).toBe('240000')
      expect(cell(html, 'sold', 'basis')).toBe('300000')
      expect(fleetTotals(atDate('2026-03-31', a))).toMatchObject({ assets: 4, gpus: 32, basis: 1_617_000, nbvBook: 1_366_950, nbvTax: 1_167_850 })
      expect(html).toContain(`data-total="nbv_book">${money(1_366_950)}`)
    })

    it.each(['2026-06-30', '2026-09-30'])('on or after (%s): excluded, and its row shows a dash', asOf => {
      const a = sold(asOf, 0, 0)
      const html = register({ assets: atDate(asOf, a) })
      expect(cell(html, 'sold', 'nbv_book')).toBe('')
      expect(cell(html, 'sold', 'basis')).toBe('')
      expect(fleetTotals(atDate(asOf, a))).toMatchObject({ assets: 3, gpus: 24, basis: 1_317_000, nbvBook: 1_081_950 })
      expect(html).toContain(`data-total="nbv_book">${money(1_081_950)}`)
    })

    it('write actions follow the status today: a disposed asset offers no Purchase or Dispose at any date', () => {
      const html = register({ assets: atDate('2026-03-31', sold('2026-03-31', 285_000, 240_000)) })
      expect(button(html, 'sold', 'Purchase')).toBeNull()
      expect(button(html, 'sold', 'Dispose')).toBeNull()
    })

    it('/fleet and the lead page total the same way (both use fleetTotals)', () => {
      const html = renderToStaticMarkup(
        <CurrencyProvider currency="USD">
          <FleetOverviewView vehicles={[{ id: 'v1', name: 'H200 SPV I', active: true }]} loaded={{ v1: { assets: atDate('2026-03-31', sold('2026-03-31', 285_000, 240_000)) } }} asOf="2026-03-31" />
        </CurrencyProvider>,
      )
      expect(html).toContain(`>${money(1_366_950)}<`)
      expect(readFileSync(path.join(process.cwd(), 'app/(app)/funds/[id]/gpu-detail-view.tsx'), 'utf8')).toContain('fleetTotals(r.data.assets)')
    })
  })

  describe('on the books follows the route\u2019s on_books_as_of (#108), not a client rule', () => {
    // The route reports an off-book asset with every value 0 and its basis; the page sums what it sends.
    const offBook = (over: Partial<ValuedAsset>) => asset({ on_books_as_of: false, accumulated_book: 0, nbv_book: 0, accumulated_tax: 0, nbv_tax: 0, ...over })

    it('planned (false): basis under Planned, captioned Planned, nothing in the totals', () => {
      const plan = offBook({ id: 'plan', name: 'Planned H200', status: 'planned', purchase_entry_id: null, hardware_cost: 335_000, basis: 335_000 })
      expect(fleetTotals([...PACK, plan])).toMatchObject({ basis: 1_317_000, planned: 335_000, nbvBook: 1_081_950, nbvTax: 927_850 })
      const html = register({ assets: [...PACK, plan] })
      expect(cell(html, 'plan', 'nbv_book')).toBe('')
      expect(html).toMatch(/data-asset="plan"[\s\S]*?data-col="planned" data-value="335000"[^>]*>[^<]*<span[^>]*>Planned</)
      expect(html).toContain(`data-total="planned">${money(335_000)}`)
    })

    it('purchased after the as-of date (false): the same, captioned Not on the books at this date', () => {
      const later = offBook({ id: 'later', status: 'in_service', purchase_entry_id: 'je-later', basis: 410_000 })
      expect(isOffBooks(later)).toBe(true)
      expect(offBooksLabel(later)).toBe('Not on the books at this date')
      expect(fleetTotals([...PACK, later])).toMatchObject({ planned: 410_000, nbvBook: 1_081_950, inService: 4, gpus: 32 })
      expect(register({ assets: [...PACK, later] })).toMatch(/data-asset="later"[\s\S]*?data-col="planned" data-value="410000"[^>]*>[^<]*<span[^>]*>Not on the books at this date</)
    })

    it('an unlinked but posted purchase (true) is counted: the route recognises it, so the page does too', () => {
      const unlinked = asset({ id: 'ul', status: 'ordered', purchase_entry_id: null, basis: 410_000, accumulated_book: 6_150, nbv_book: 403_850, nbv_tax: 403_850 })
      expect(isOffBooks(unlinked)).toBe(false)
      expect(fleetTotals([...PACK, unlinked])).toMatchObject({ basis: 1_727_000, planned: 0, nbvBook: 1_485_800 })
      expect(cell(register({ assets: [...PACK, unlinked] }), 'ul', 'nbv_book')).toBe('403850')
    })

    it('in service (true) is counted at the route\u2019s figures', () => {
      expect(isOffBooks(PACK[0])).toBe(false)
      expect(cell(register(), 'h200', 'nbv_book')).toBe('274700')
    })

    it('disposed on or before the as-of date (true, values 0): excluded and shown as a dash', () => {
      const gone = asset({ id: 'gone', status: 'disposed', disposed_on: '2026-06-30', basis: 300_000, nbv_book: 0, nbv_tax: 0, accumulated_book: 300_000 })
      expect(isOffBooks(gone)).toBe(false)
      expect(fleetTotals([...PACK, gone])).toMatchObject({ assets: 3, basis: 1_317_000, nbvBook: 1_081_950 })
      expect(cell(register({ assets: [...PACK, gone] }), 'gone', 'nbv_book')).toBe('')
    })

    it('counts follow status: an off-book asset in service counts in GPUs and in service, and adds 0 to book and tax', () => {
      const running = offBook({ id: 'run', status: 'in_service', gpu_count: 8, basis: 400_000 })
      expect(fleetTotals([running])).toEqual({ ...ZERO_TOTALS, assets: 1, gpus: 8, inService: 1, planned: 400_000 })
    })

    it('the earlier-date caveat and its TODO are gone: the flag answers the question', () => {
      const html = register({ assets: PACK.map(p => ({ ...p, valuation_as_of: '2020-01-31' })) })
      expect(html).not.toContain('data-earlier-date-caveat')
      expect(readFileSync(path.join(process.cwd(), 'components/gpu/fleet-math.ts'), 'utf8')).not.toContain('TODO(gpu-P1 on_books_as_of)')
    })
  })
})

describe('the as-of date is sent on every assets fetch', () => {
  it.each([
    ['the register', (f: Fetcher) => listAssets(f, '2026-06-30'), '/api/fleet/assets?as_of=2026-06-30'],
    ['one asset', (f: Fetcher) => getAsset(f, 'b300', '2026-06-30'), '/api/fleet/assets/b300?as_of=2026-06-30'],
    ['a named vehicle (/fleet, the lead page)', (f: Fetcher) => listVehicleAssets(f, 'H200 SPV I', '2026-06-30'), '/api/fleet/assets?group=H200%20SPV%20I&as_of=2026-06-30'],
  ])('%s', async (_label, run, path) => {
    const { fetcher, calls } = fakeFetcher({ status: 200, body: { assets: [] } })
    await run(fetcher)
    expect(calls[0].path).toBe(path)
  })

  it('a bad as-of comes back as the route\u2019s 400 in its words', async () => {
    const { fetcher } = fakeFetcher({ status: 400, body: { error: 'as_of must be a date, YYYY-MM-DD' } })
    expect(await listAssets(fetcher, '2026-02-30')).toEqual({ ok: false, status: 400, error: 'as_of must be a date, YYYY-MM-DD' })
  })

  it('no assets fetch can be made without an as-of: it is a required argument of every helper (checked by tsc)', async () => {
    // Every page fetches assets only through these three helpers, so none can fall back on the
    // route's UTC default. The @ts-expect-error lines fail `tsc --noEmit` if as-of ever becomes optional.
    const { fetcher, calls } = fakeFetcher({ status: 200, body: { assets: [] } }, { status: 200, body: {} }, { status: 200, body: { assets: [] } })
    // @ts-expect-error as-of is required
    await listAssets(fetcher)
    // @ts-expect-error as-of is required
    await getAsset(fetcher, 'b300')
    // @ts-expect-error as-of is required
    await listVehicleAssets(fetcher, 'H200 SPV I')
    // At runtime the missing date reaches the request as a literal, which the route refuses with its 400.
    expect(calls.map(c => new URL(c.path, 'http://x').searchParams.get('as_of'))).toEqual(['undefined', 'undefined', 'undefined'])
  })

  it('the as-of field commits only a complete, real date; partial and impossible ones are held back', () => {
    for (const v of ['', '2026', '2026-0', '2026-02', '2026-02-3', '2026-13-01', '2026-02-30', '2026-04-31', '20260331']) {
      expect(asOfCommit(v), v).toBeNull()
    }
    expect(asOfCommit('2026-03-31')).toBe('2026-03-31')
    expect(asOfCommit('2028-02-29')).toBe('2028-02-29')
    expect(asOfCommit('2026-02-29')).toBeNull()
  })

  it('the client depreciation path is gone: fleet-math does not import lib/gpu/depreciation', () => {
    expect(readFileSync(path.join(process.cwd(), 'components/gpu/fleet-math.ts'), 'utf8')).not.toMatch(/@\/lib\/gpu\/depreciation/)
  })
})

describe('the asset\u2019s book, tax and capex', () => {
  const view = (a: ValuedAsset) => renderToStaticMarkup(<CurrencyProvider currency="USD"><ValuationCard asset={a} /></CurrencyProvider>)
  const col = (html: string, c: string) => html.match(new RegExp(`data-col="${c}">([^<]*)<`))?.[1]

  it('shows the server\u2019s basis, book and tax book figures, and the date they are valued as of', () => {
    const html = view(PACK[0])
    expect(col(html, 'basis')).toBe(money(335_000))
    expect(col(html, 'accumulated_book')).toBe(money(60_300))
    expect(col(html, 'nbv_book')).toBe(money(274_700))
    expect(col(html, 'accumulated_tax')).toBe(money(214_400))
    expect(col(html, 'nbv_tax')).toBe(money(120_600))
    expect(html).toContain('Tax book')
    expect(html).toContain('(Bonus)')
    expect(html).toContain(`data-valuation-as-of="${AS_OF}"`)
  })

  it('a planned asset (off the books) shows its basis and no book or tax value', () => {
    const html = view(asset({ status: 'planned', purchase_entry_id: null, on_books_as_of: false, basis: 335_000, nbv_book: 0, nbv_tax: 0 }))
    expect(col(html, 'basis')).toBe(money(335_000))
    expect(col(html, 'nbv_book')).toBe('—')
    expect(col(html, 'nbv_tax')).toBe('—')
    expect(html).toContain(`Planned: not purchased as of ${AS_OF}`)
  })

  it('an asset purchased later says it is not on the books as of the date: its purchase is not recognised then', () => {
    const html = view(asset({ status: 'in_service', purchase_entry_id: 'je', on_books_as_of: false, basis: 410_000, nbv_book: 0, nbv_tax: 0 }))
    expect(html).toContain(`Not on the books as of ${AS_OF}: its purchase is not recognised at this date.`)
    expect(html).not.toMatch(/Unbooked|not linked/)
    expect(col(html, 'nbv_book')).toBe('—')
  })

  it('an unlinked but posted purchase is on the books: the card shows its figures', () => {
    const html = view(asset({ status: 'ordered', purchase_entry_id: null, on_books_as_of: true, basis: 410_000, accumulated_book: 6_150, nbv_book: 403_850, nbv_tax: 403_850 }))
    expect(col(html, 'nbv_book')).toBe(money(403_850))
    expect(html).not.toContain('Not on the books')
  })

  it('lists the capex events: month, amount, source ref and when posted', () => {
    const html = renderToStaticMarkup(<CurrencyProvider currency="USD"><CapexEventsTable events={PACK[2].capex_events} /></CurrencyProvider>)
    const row = html.match(/<tr[^>]*data-capex="gpu-asset:b300:capex:inv-881"[\s\S]*?<\/tr>/)?.[0] ?? ''
    expect(row).toContain('>2026-03<')
    expect(row).toContain(`>${money(12_000)}<`)
    expect(row).toContain('>gpu-asset:b300:capex:inv-881<')
    expect(html).toContain(utcToLocalLabel('2026-03-14T15:20:00Z'))
    expect(renderToStaticMarkup(<CurrencyProvider currency="USD"><CapexEventsTable events={[]} /></CurrencyProvider>)).toContain('Nothing capitalized as of this date')
  })
})

describe('Purchase and Dispose need accounting write', () => {
  const fleet = [asset({ id: 'p', name: 'Planned', status: 'planned', purchase_entry_id: null, in_service_date: null }), PACK[0]]

  it('are disabled, with the reason, without it', () => {
    const html = register({ assets: fleet, canBook: false })
    expect(button(html, 'p', 'Purchase')).toMatch(/disabled=""/)
    expect(button(html, 'p', 'Purchase')).toContain('needs write access to Accounting')
    expect(button(html, 'h200', 'Dispose')).toMatch(/disabled=""/)
    // Deleting a planned server is a register change: fleet write is enough.
    expect(button(html, 'p', 'Delete')).not.toMatch(/disabled=""/)
  })

  it('are enabled with it', () => {
    const html = register({ assets: fleet, canBook: true })
    expect(button(html, 'p', 'Purchase')).not.toMatch(/disabled=""/)
    expect(button(html, 'h200', 'Dispose')).not.toMatch(/disabled=""/)
  })

  it('name the grant that is missing: the fleet, Accounting, or both', () => {
    const hint = (canWriteFleet: boolean, canBook: boolean) => button(register({ assets: fleet, canWriteFleet, canBook }), 'p', 'Purchase')
    expect(hint(false, true)).toMatch(/disabled=""[^>]*title="This needs write access to the GPU fleet\."/)
    expect(hint(true, false)).toMatch(/title="This needs write access to Accounting\."/)
    expect(hint(false, false)).toMatch(/title="This needs write access to the GPU fleet and to Accounting\."/)
  })

  it('a 403 from the route is shown in its own words', async () => {
    const message = 'Booking this to the ledger needs write access to Accounting.'
    const { fetcher, calls } = fakeFetcher({ status: 403, body: { error: message } })
    const r = await send(fetcher, fleetPaths.purchase('p'), 'POST', { entryDate: '2026-01-05', invoiced: false })
    expect(calls[0].path).toBe('/api/fleet/assets/p/purchase')
    expect(r).toEqual({ ok: false, status: 403, error: message })
    expect(renderToStaticMarkup(<ErrorAlert>{!r.ok && r.error}</ErrorAlert>)).toContain(message)
  })

  it('a dropped connection is a message, not a silent failure', async () => {
    const r = await send(async () => { throw new TypeError('Failed to fetch') }, fleetPaths.assets, 'POST', {})
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/Could not reach the server/)
  })
})

describe('which actions a row offers', () => {
  // Purchase is the route's recovery path too (purchaseAsset adopts and links a booked entry), so it
  // is offered for any unlinked asset not disposed of; Dispose and Capitalize need the purchase linked.
  const rows = [
    asset({ id: 'planned', status: 'planned', purchase_entry_id: null, in_service_date: null }),
    asset({ id: 'ordered-unlinked', status: 'ordered', purchase_entry_id: null }),
    asset({ id: 'ordered', status: 'ordered', purchase_entry_id: 'je' }),
    asset({ id: 'running-unlinked', status: 'in_service', purchase_entry_id: null }),
    asset({ id: 'in-service', status: 'in_service', purchase_entry_id: 'je' }),
    asset({ id: 'offline', status: 'offline', purchase_entry_id: 'je' }),
    asset({ id: 'disposed', status: 'disposed', purchase_entry_id: 'je', disposed_on: '2026-06-30' }),
  ]
  const html = register({ assets: rows })
  const offered = (id: string) => ['Purchase', 'Dispose', 'Delete', 'Put in service', 'Take offline'].filter(l => button(html, id, l))

  it.each([
    ['planned', ['Purchase', 'Delete']],
    ['ordered-unlinked', ['Purchase']],
    ['ordered', ['Dispose', 'Put in service']],
    ['running-unlinked', ['Purchase', 'Take offline']],
    ['in-service', ['Dispose', 'Take offline']],
    ['offline', ['Dispose', 'Put in service']],
    ['disposed', []],
  ])('%s offers %j', (id, labels) => {
    expect(offered(id)).toEqual(labels)
  })

  it('Capitalize follows Dispose: only once the purchase is linked', () => {
    expect(rows.map(a => [a.id, offersBookedActions(a)])).toEqual([
      ['planned', false], ['ordered-unlinked', false], ['ordered', true], ['running-unlinked', false],
      ['in-service', true], ['offline', true], ['disposed', false],
    ])
  })
})

describe('status moves', () => {
  it.each([
    ['ordered', 'in_service'],
    ['in_service', 'offline'],
    ['offline', 'in_service'],
  ] as const)('%s \u2192 %s sends { status } as a PATCH the route accepts', async (from, to) => {
    const a = asset({ id: 'x', status: from, purchase_entry_id: 'je' })
    expect(statusMoves(a)).toEqual([to])
    const { fetcher, calls } = fakeFetcher({ status: 200, body: {} })
    await send(fetcher, fleetPaths.asset('x'), 'PATCH', statusBody(to))
    expect(calls[0]).toMatchObject({ path: '/api/fleet/assets/x', init: { method: 'PATCH' }, body: { status: to } })
    expect(parseAssetInput(calls[0].body, true)).toEqual({ value: { status: to } })
    // The editor sends the same move, and only it.
    expect(assetPatch(a, { ...assetFormOf(a), status: to })).toEqual({ status: to })
  })

  it('offers no move from planned, disposed, or an ordered asset whose purchase is still being linked', () => {
    expect(statusMoves(asset({ status: 'planned', purchase_entry_id: null }))).toEqual([])
    expect(statusMoves(asset({ status: 'disposed' }))).toEqual([])
    expect(statusMoves(asset({ status: 'ordered', purchase_entry_id: null }))).toEqual([])
  })

  it('a disallowed move comes back as the route\u2019s 409, in its words', async () => {
    const message = 'Status cannot change from offline to ordered here: an asset is ordered by booking its purchase and disposed of by its disposal, and never returns to planned'
    const { fetcher } = fakeFetcher({ status: 409, body: { error: message } })
    expect(await send(fetcher, fleetPaths.asset('x'), 'PATCH', statusBody('ordered'))).toEqual({ ok: false, status: 409, error: message })
  })

  it('a new asset for a running fleet may start in service; planned is left to the default', () => {
    expect(assetBody({ ...EMPTY_ASSET_FORM, name: 'A', hardware_cost: '1', status: 'in_service' })).toMatchObject({ status: 'in_service' })
    expect(assetBody({ ...EMPTY_ASSET_FORM, name: 'A', hardware_cost: '1' })).not.toHaveProperty('status')
  })
})

describe('Add asset', () => {
  const form = {
    ...EMPTY_ASSET_FORM, name: ' H200 NVL #1 ', asset_type_id: 't1', gpu_count: '8', hardware_cost: '335,000',
    serials: 'SN-1\nSN-2, SN-3', in_service_date: '2026-01-01', tax_method: 'bonus', tax_bonus_pct: '60', tax_life_years: '5',
  }

  it('posts the fields parseAssetInput reads, with salvage left to its 10% default', async () => {
    const body = assetBody(form)
    expect(body).toEqual({
      name: 'H200 NVL #1', asset_type_id: 't1', gpu_count: 8, hardware_cost: 335_000, serials: ['SN-1', 'SN-2', 'SN-3'],
      useful_life_months: 60, depreciation_convention: 'full_month', in_service_date: '2026-01-01',
      tax_method: 'bonus', tax_bonus_pct: 0.6, tax_life_years: 5,
    })
    const parsed = parseAssetInput(body, false)
    expect(parsed).toEqual({ value: expect.objectContaining({ ...body, salvage_value: 33_500 }) })

    const { fetcher, calls } = fakeFetcher({ status: 201, body: { id: 'new' } })
    const r = await send(fetcher, fleetPaths.assets, 'POST', body)
    expect(r.ok).toBe(true)
    expect(calls[0]).toMatchObject({ path: '/api/fleet/assets', init: { method: 'POST' }, body })
  })

  it('a 400 comes back as the route’s message', async () => {
    const { fetcher } = fakeFetcher({ status: 400, body: { error: 'gpu_count must be a positive whole number' } })
    const r = await send(fetcher, fleetPaths.assets, 'POST', assetBody({ ...form, gpu_count: '0' }))
    expect(r).toEqual({ ok: false, status: 400, error: 'gpu_count must be a positive whole number' })
  })

  it('an edit sends only what changed, so leaving the cost alone never trips the booked-cost refusal', () => {
    const a = PACK[0]
    const patch = assetPatch(a, { ...assetFormOf(a), notes: 'Rack 4' })
    expect(patch).toEqual({ notes: 'Rack 4' })
    expect(parseAssetInput(patch, true)).toEqual({ value: { notes: 'Rack 4' } })
    // Clearing an optional field sends null, which the route accepts.
    expect(assetPatch({ ...a, notes: 'Rack 4' }, { ...assetFormOf({ ...a, notes: 'Rack 4' }), notes: '' })).toEqual({ notes: null })
  })
})

describe('the edit form never drops a cleared field silently', () => {
  const a = asset({ tax_method: 'bonus', tax_bonus_pct: 0.6, tax_life_years: 5, salvage_value: 33_500, hardware_cost: 335_000 })

  it('a cleared Bonus % is sent as 0', () => {
    const patch = assetPatch(a, { ...assetFormOf(a), tax_bonus_pct: '' })
    expect(patch).toEqual({ tax_bonus_pct: 0 })
    expect(parseAssetInput(patch, true)).toEqual({ value: { tax_bonus_pct: 0 } })
  })

  it('a cleared Salvage or Useful life is refused by the form on edit (on create, blank salvage is the 10% default)', () => {
    expect(assetFormError({ ...assetFormOf(a), salvage_value: '' }, true)).toBe('Enter a salvage value (0 for none).')
    expect(assetFormError({ ...assetFormOf(a), useful_life_months: '' }, true)).toBe('Enter the useful life in months.')
    expect(assetFormError({ ...EMPTY_ASSET_FORM, name: 'A', hardware_cost: '335,000' }, false)).toBeNull()
    expect(assetFormError(assetFormOf(a), true)).toBeNull()
  })
})

describe('money typed with commas', () => {
  it('is accepted by every amount field and sent as a number', () => {
    expect(validAmount('1,000')).toBe(true)
    expect(validAmount('$12,000.50', true)).toBe(true)
    expect(validAmount('0', true)).toBe(false)
    expect(validAmount('')).toBe(false)
    expect(validAmount('abc')).toBe(false)
    expect(disposeBody('2026-06-30', '1,000')).toEqual({ disposedOn: '2026-06-30', proceeds: 1_000 })
  })
})

describe('Capitalize a cost', () => {
  it('reuses one idempotency key across a retry, and takes a new one when reopened', async () => {
    let n = 0
    const { fetcher, calls } = fakeFetcher(
      { status: 409, body: { error: 'This cost is being booked by another request', inProgress: true } },
      { status: 200, body: { entryId: 'je' } },
    )
    const s = capexSubmitter(fetcher, 'h200', () => `key-${++n}`)
    const form = { amount: '12,000', entryDate: '2026-02-10', memo: 'Rack installation', invoiced: false }
    const first = await s.submit(form)
    expect(first).toEqual({ ok: false, status: 409, error: 'This cost is being booked by another request' })
    expect((await s.submit(form)).ok).toBe(true)
    expect(calls.map(c => c.body.key)).toEqual(['key-1', 'key-1'])
    expect(calls[0]).toMatchObject({ path: '/api/fleet/assets/h200/capex', body: { amount: 12_000, entryDate: '2026-02-10', memo: 'Rack installation', invoiced: false } })
  })

  // Each static render is a fresh mount, exactly what reopening the dialog is: whileOpen unmounts the
  // body on close and mounts it again on open, and the submitter (so the key) lives for one mount.
  const renderCapex = (open: boolean, newKey?: () => string) => renderToStaticMarkup(
    <CurrencyProvider currency="USD">
      <CapexDialog open={open} onOpenChange={() => {}} fetcher={async () => new Response('{}')} onDone={() => {}} asset={PACK[0]} newKey={newKey} />
    </CurrencyProvider>,
  )

  it('the real dialog makes two distinct keys across two openings, and none while closed (default crypto key)', () => {
    const spy = vi.spyOn(globalThis.crypto, 'randomUUID')
    try {
      renderCapex(false)
      expect(spy).not.toHaveBeenCalled()
      renderCapex(true)
      renderCapex(true)
      const keys = spy.mock.results.map(r => r.value as string)
      expect(keys).toHaveLength(2)
      expect(new Set(keys).size).toBe(2)
      expect(keys.every(k => /^[A-Za-z0-9_-]{1,64}$/.test(k))).toBe(true) // the route's CAPEX_KEY
    } finally {
      spy.mockRestore()
    }
  })

  it('the dialog body takes its submitter only through useCapexSubmitter (structural: the key lives in the hook\u2019s state)', () => {
    // A full behavioural guard (type into the real dialog, assert one key) needs a DOM test environment,
    // which this repo does not have yet; it is proposed separately. Until then: the body may not build a
    // submitter itself, and the hook below is tested behaviourally across re-renders.
    const src = readFileSync(path.join(process.cwd(), 'components/gpu/fleet-dialogs.tsx'), 'utf8')
    const start = src.indexOf('function CapexDialogBody(')
    const body = src.slice(start, src.indexOf('\n})\n', start))
    expect(start).toBeGreaterThan(-1)
    expect(body).toMatch(/const submitter = useCapexSubmitter\(/)
    expect(body).not.toMatch(/\bcapexSubmitter\(/) // the hook is useCapexSubmitter (capital C); a direct call is lowercase
    const hook = src.slice(src.indexOf('export function useCapexSubmitter('), src.indexOf('export const CapexDialog'))
    expect(hook).toMatch(/useState\(\(\) => capexSubmitter\(/)
  })

  it('the key survives re-renders within one opening (typing in the form must not mint a new key)', () => {
    // A render-phase state update re-runs the component in the same mount, as each keystroke does.
    const seen: string[] = []
    let n = 0
    const Probe = whileOpen(function Probe(p: { open: boolean; onOpenChange: () => void; fetcher: Fetcher; onDone: () => void }) {
      const [renders, setRenders] = useState(0)
      const s = useCapexSubmitter(p.fetcher, 'h200', () => `key-${++n}`)
      seen.push(s.key())
      if (renders < 2) setRenders(renders + 1)
      return null
    })
    renderToStaticMarkup(<Probe open onOpenChange={() => {}} fetcher={async () => new Response('{}')} onDone={() => {}} />)
    expect(seen).toEqual(['key-1', 'key-1', 'key-1'])
  })

  it('within one opening, a retry after a 409 sends the same key the opening made', async () => {
    // The dialog's own hook, mounted by the same whileOpen, with its submitter taken out of the mount so
    // the test can submit twice as the dialog's Capitalize button does.
    let held: ReturnType<typeof useCapexSubmitter> | null = null
    let n = 0
    const { fetcher, calls } = fakeFetcher(
      { status: 409, body: { error: 'This cost is being booked by another request', inProgress: true } },
      { status: 200, body: { entryId: 'je' } },
    )
    const Probe = whileOpen(function Probe(p: { open: boolean; onOpenChange: () => void; fetcher: Fetcher; onDone: () => void }) {
      held = useCapexSubmitter(p.fetcher, 'h200', () => `key-${++n}`)
      return null
    })
    renderToStaticMarkup(<Probe open onOpenChange={() => {}} fetcher={fetcher} onDone={() => {}} />)
    const form = { amount: '12,000', entryDate: '2026-02-10', memo: 'Rack installation', invoiced: false }
    expect((await held!.submit(form)).ok).toBe(false)
    expect((await held!.submit(form)).ok).toBe(true)
    expect(calls.map(c => c.body.key)).toEqual(['key-1', 'key-1'])
    // A second opening is a new mount, so a new cost with a new key.
    renderToStaticMarkup(<Probe open onOpenChange={() => {}} fetcher={fetcher} onDone={() => {}} />)
    expect(held!.key()).toBe('key-2')
  })
})

describe('datacenter contracts', () => {
  const contract: DatacenterContractRow = {
    id: 'c1', fund_id: 'f', vehicle_id: 'v', vendor_id: null, facility: 'Equinix DA11', start_date: '2026-01-01', end_date: null,
    monthly_fee: 10_280, escalator_pct: 0.05, escalates_on: 'anniversary', first_escalation_date: null, power_kw: null,
    includes_connectivity: false, deposit: null, schedule_id: 's1', allocation: 'none', status: 'active',
  }

  it('End sends end_date and status ended as a PATCH', async () => {
    const { fetcher, calls } = fakeFetcher({ status: 200, body: {} })
    await send(fetcher, fleetPaths.contract('c1'), 'PATCH', endContractBody('2027-06-30'))
    expect(calls[0]).toMatchObject({ path: '/api/fleet/datacenter-contracts/c1', init: { method: 'PATCH' }, body: { end_date: '2027-06-30', status: 'ended' } })
    expect(parseContractInput(calls[0].body, true)).toEqual({ value: { end_date: '2027-06-30', status: 'ended' } })
  })

  it('Roll sends { action: roll, asOf } as a POST', async () => {
    const { fetcher, calls } = fakeFetcher({ status: 200, body: {} })
    await send(fetcher, fleetPaths.contract('c1'), 'POST', rollBody('2026-12-31'))
    expect(calls[0]).toMatchObject({ init: { method: 'POST' }, body: { action: 'roll', asOf: '2026-12-31' } })
  })

  it('Add sends JSON numbers parseContractInput accepts, and asks for the schedule only with accounting write', () => {
    const form = { ...EMPTY_CONTRACT_FORM, facility: 'Equinix DA11', start_date: '2026-01-01', monthly_fee: '10,280', escalator_pct: '5' }
    const withSchedule = contractBody(form, true)
    expect(withSchedule).toEqual({ facility: 'Equinix DA11', start_date: '2026-01-01', monthly_fee: 10_280, escalator_pct: 0.05, escalates_on: 'anniversary', schedule: true })
    expect('error' in parseContractInput(withSchedule, false)).toBe(false)
    expect(contractBody(form, false).schedule).toBe(false)
  })

  it('End and Roll are disabled without accounting write', () => {
    const html = (canBook: boolean) => renderToStaticMarkup(
      <CurrencyProvider currency="USD"><ContractsTable contracts={[contract]} canWriteFleet canBook={canBook} onEnd={() => {}} onRoll={() => {}} /></CurrencyProvider>,
    )
    expect(html(false)).toMatch(/<button[^>]*disabled=""[^>]*>End contract<\/button>/)
    expect(html(false)).toMatch(/<button[^>]*disabled=""[^>]*>Roll schedules<\/button>/)
    expect(html(true)).not.toMatch(/disabled=""/)
    expect(html(true)).toContain('5%')
  })
})

describe('events', () => {
  const ms = (iso: string) => Date.parse(iso)

  it('a same-day two-hour outage is two hours: local wall-clock times become UTC instants', () => {
    const body = eventBody({ kind: 'downtime', starts_at: '2026-03-01T10:00', ends_at: '2026-03-01T12:00', gpus_affected: '2', cause: 'PSU' })
    expect(body).toEqual({
      kind: 'downtime', starts_at: new Date('2026-03-01T10:00').toISOString(), ends_at: new Date('2026-03-01T12:00').toISOString(),
      gpus_affected: 2, cause: 'PSU',
    })
    expect(body.starts_at).toMatch(/Z$/)
    expect(ms(body.ends_at as string) - ms(body.starts_at as string)).toBe(2 * 60 * 60 * 1000)
  })

  it('an ongoing event has no end; a bare date is the start of that local day', () => {
    const body = eventBody({ kind: 'note', starts_at: '2026-03-01', ends_at: '', gpus_affected: '', cause: '' })
    expect(body).toEqual({ kind: 'note', starts_at: new Date('2026-03-01T00:00').toISOString(), ends_at: null, gpus_affected: null })
  })

  it('refuses a value that is not a real date or time before converting it, so the form never throws', () => {
    expect(() => localToUtc('2026-13-40T10:00')).toThrow(RangeError)
    expect(eventFormError({ starts_at: '2026-13-40T10:00', ends_at: '' })).toBe('Enter a valid start date and time.')
    expect(eventFormError({ starts_at: '2026-02-30T10:00', ends_at: '' })).toBe('Enter a valid start date and time.')
    expect(eventFormError({ starts_at: '', ends_at: '' })).toBe('Enter a valid start date and time.')
    expect(eventFormError({ starts_at: '2026-03-01T10:00', ends_at: '2026-03-01T25:00' })).toMatch(/valid end date/)
    expect(eventFormError({ starts_at: '2026-03-01T12:00', ends_at: '2026-03-01T10:00' })).toBe('The end must be on or after the start.')
    expect(eventFormError({ starts_at: '2026-03-01T10:00', ends_at: '2026-03-01T12:00' })).toBeNull()
    expect(eventFormError({ starts_at: '2026-03-01', ends_at: '' })).toBeNull()
    // A bare date is local midnight on both sides, never UTC midnight against a local time.
    expect(eventFormError({ starts_at: '2026-03-01', ends_at: '2026-03-01T00:30' })).toBeNull()
    expect(eventFormError({ starts_at: '2026-03-01T00:30', ends_at: '2026-03-01' })).toBe('The end must be on or after the start.')
  })

  it('the event form checks before it converts or goes busy, and always leaves busy', () => {
    const s = readFileSync(path.join(process.cwd(), 'components', 'gpu', 'asset-detail.tsx'), 'utf8')
    const body = s.slice(s.indexOf('async function record'), s.indexOf('return (', s.indexOf('async function record')))
    expect(body.indexOf('eventFormError(form)')).toBeGreaterThan(-1)
    expect(body.indexOf('eventFormError(form)')).toBeLessThan(body.indexOf('setBusy(true)'))
    expect(body.indexOf('setBusy(true)')).toBeLessThan(body.indexOf('eventBody(form)'))
    expect(body).toMatch(/finally \{\s*setBusy\(false\)/)
  })

  it('shows a stored instant back as the same wall-clock time it was entered at', () => {
    expect(utcToLocalLabel(localToUtc('2026-03-01T10:00'))).toBe('2026-03-01 10:00')
    expect(nowLocalInput(new Date(2026, 2, 1, 9, 5))).toBe('2026-03-01T09:05')
  })
})

describe('today', () => {
  it('is the local calendar date, not the UTC one (the as-of default)', () => {
    const d = new Date()
    const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    expect(todayIso()).toBe(local)
  })
})

describe('the firm-wide overview', () => {
  const vehicles = [{ id: 'v1', name: 'H200 SPV I', active: true }, { id: 'v2', name: 'B300 SPV II', active: true }]
  const view = (loaded: Parameters<typeof FleetOverviewView>[0]['loaded']) => renderToStaticMarkup(
    <CurrencyProvider currency="USD"><FleetOverviewView vehicles={vehicles} loaded={loaded} asOf={AS_OF} /></CurrencyProvider>,
  )

  it('shows a vehicle that failed to load on its own card, and says the totals are partial', () => {
    const html = view({ v1: { assets: PACK }, v2: { error: 'Could not read the record' } })
    expect(html).toMatch(/data-vehicle="v2"[\s\S]*?role="alert"[^>]*>Could not read the record</)
    expect(html).toContain('Partial: 1 vehicle could not be loaded')
    expect(html).toContain(money(1_081_950))
  })

  it('totals every vehicle when all load, with planned cost said apart', () => {
    const plan = asset({ id: 'plan', status: 'planned', purchase_entry_id: null, on_books_as_of: false, hardware_cost: 335_000, basis: 335_000, nbv_book: 0 })
    const html = view({ v1: { assets: PACK }, v2: { assets: [plan] } })
    expect(html).not.toContain('Partial')
    expect(html).toContain(`On the books; ${money(335_000)} more not on the books yet`)
    // Fleet NBV is the booked pack's, from the server: the planned 335,000 is not in it.
    expect(html).toContain(`>${money(1_081_950)}<`)
    expect(html).toContain(`tax book ${money(927_850)}`)
  })

  it('shows the date the server valued the registers as of, not the date it asked for', () => {
    const html = view({ v1: { assets: PACK.map(p => ({ ...p, valuation_as_of: '2026-12-30' })) }, v2: { assets: [] } })
    expect(html).toContain('Book, as of 2026-12-30')
    expect(html).toContain('data-valuation-as-of="2026-12-30"')
    expect(valuationDate([], '2026-12-31')).toBe('2026-12-31')
    expect(valuationDate(PACK)).toBe(AS_OF)
    expect(html).toContain('LTM revenue')
    expect(html).toContain('Utilization')
  })
})

describe('the firm-wide overview\u2019s requests', () => {
  it('keeps at most `limit` in flight and returns results in order', async () => {
    let live = 0
    let peak = 0
    const out = await mapBounded([1, 2, 3, 4, 5, 6, 7], 3, async n => {
      live++; peak = Math.max(peak, live)
      await new Promise(r => setTimeout(r, 1))
      live--
      return n * 10
    })
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70])
    expect(peak).toBe(3)
  })
})

describe('load failures and the URL\u2019s vehicle (pinned in source: these run in effects a static render does not)', () => {
  const src = (f: string) => readFileSync(path.join(process.cwd(), 'components', 'gpu', f), 'utf8')

  it('the register keeps one error per list, so a good assets load never clears a types or contracts failure', () => {
    const s = src('fleet-register.tsx')
    expect(s).toContain('setTypesError(r.ok ? null : r.error)')
    expect(s).toContain('setLoadError(a.ok ? null : a.error)')
    expect(s).toContain('setContractsError(c.ok ? null : c.error)')
    expect(s).not.toMatch(/setLoadError\([^)]*c\.error/)
    expect(s).toMatch(/\{typesError && [\s\S]*?<ErrorAlert>/)
    expect(s).toMatch(/\{contractsError && [\s\S]*?<ErrorAlert>/)
  })

  it('the asset page shows types and contracts failures inline and never reads them as No type or a dash', () => {
    const s = src('asset-detail.tsx')
    expect(s).toContain('setTypesError(r.ok ? null : r.error)')
    expect(s).toContain('setContractsError(c.ok ? null : c.error)')
    expect(s).toContain("typesError ? 'Type unavailable'")
    expect(s).toContain("contractsError ? 'Unavailable'")
  })

  it('the asset page renders not found for an asset of another vehicle', () => {
    const s = src('asset-detail.tsx')
    expect(s).toMatch(/if \(asset\.vehicle_id !== vehicleId\) \{\s*return \(\s*<EmptyState/)
  })
})
