import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
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
import { DepreciationTable, trueUpIndex } from '@/components/gpu/asset-detail'
import { CapexDialog, useCapexSubmitter, whileOpen } from '@/components/gpu/fleet-dialogs'
import { ErrorAlert } from '@/components/gpu/fleet-ui'
import { assetFigures, assetSchedule, fleetTotals, offersBookedActions, statusMoves, todayIso } from '@/components/gpu/fleet-math'
import { FleetOverviewView } from '@/components/gpu/fleet-overview'
import {
  EMPTY_ASSET_FORM, EMPTY_CONTRACT_FORM, assetBody, assetFormError, assetFormOf, assetPatch, disposeBody, validAmount, capexSubmitter, contractBody, endContractBody, eventBody,
  fleetPaths, localToUtc, mapBounded, nowLocalInput, rollBody, send, statusBody, utcToLocalLabel, type Fetcher,
} from '@/components/gpu/fleet-api'
import { parseAssetInput } from '@/lib/gpu/assets'
import { parseContractInput } from '@/lib/gpu/opex'
import type { DatacenterContractRow, GpuAsset } from '@/lib/gpu/types'

const money = (n: number) => formatCurrencyFull(n, 'USD')

const asset = (over: Partial<GpuAsset>): GpuAsset => ({
  id: 'a', fund_id: 'f', vehicle_id: 'v', asset_type_id: null, name: 'Server', serials: [], vendor_id: null,
  status: 'in_service', gpu_count: 8, hardware_cost: 0, purchase_date: '2026-01-01', in_service_date: '2026-01-01',
  useful_life_months: 60, salvage_value: 0, depreciation_convention: 'full_month', tax_method: 'book', tax_bonus_pct: 0,
  tax_life_years: null, insurance_basis: null, datacenter_contract_id: null, purchase_entry_id: 'je', disposed_on: null,
  disposal_proceeds: null, disposal_entry_id: null, notes: null, capitalized_costs: 0, ...over,
})

// The pack's three servers: 8 GPUs each, 60-month life, 10% salvage, in service 1 January 2026.
const PACK = [
  asset({ id: 'h200', name: 'H200 NVL', hardware_cost: 335_000, salvage_value: 33_500 }),
  asset({ id: 'b200', name: 'B200', hardware_cost: 410_000, salvage_value: 41_000 }),
  asset({ id: 'b300', name: 'B300', hardware_cost: 560_000, salvage_value: 56_000 }),
]
const MONTHLY = { h200: 5_025, b200: 6_150, b300: 8_400 }
const AFTER_12 = '2026-12-31'

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
      assets={PACK} types={[]} contracts={[]} asOf={AFTER_12} vehicleId="v1" canWriteFleet canBook
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
  it('shows each server and its NBV after 12 months: cost less 12 monthly charges', () => {
    const html = register()
    for (const a of PACK) {
      expect(html).toContain(a.name)
      const nbv = a.hardware_cost - 12 * MONTHLY[a.id as keyof typeof MONTHLY]
      expect(html, a.id).toMatch(new RegExp(`data-asset="${a.id}"[\\s\\S]*?data-nbv="${nbv}"`))
      expect(html).toContain(money(nbv))
    }
    expect(assetFigures(PACK[0], AFTER_12)).toMatchObject({ cost: 335_000, accumulated: 60_300, nbv: 274_700, remainingMonths: 48 })
  })

  it('totals the fleet: GPUs, cost and NBV', () => {
    const html = register()
    expect(html).toMatch(/data-total="gpus"[^>]*>24</)
    expect(html).toContain(`data-total="cost">${money(1_305_000)}`)
    expect(html).toContain(`data-total="nbv">${money(1_305_000 - 12 * (5_025 + 6_150 + 8_400))}`)
  })

  it('leaves a disposed server out of the totals and shows it no book value', () => {
    const fleet = [...PACK, asset({ id: 'old', name: 'Old', hardware_cost: 100_000, status: 'disposed', disposed_on: '2026-06-30' })]
    expect(fleetTotals(fleet, AFTER_12)).toMatchObject({ assets: 3, gpus: 24, cost: 1_305_000 })
    expect(register({ assets: fleet })).toMatch(/data-asset="old"[\s\S]*?data-nbv=""/)
  })

  it('counts a planned, unbooked asset as planned cost: no book value and no simulated depreciation', () => {
    // In service on paper, but its purchase is not booked: the ledger holds nothing for it.
    const plan = asset({ id: 'plan', name: 'Planned H200', status: 'planned', purchase_entry_id: null, hardware_cost: 335_000, salvage_value: 33_500 })
    expect(assetFigures(plan, AFTER_12)).toEqual({ cost: 335_000, booked: false, accumulated: 0, nbv: null, remainingMonths: null })
    expect(assetSchedule(plan)).toEqual([])
    expect(fleetTotals([plan], AFTER_12)).toMatchObject({ cost: 0, planned: 335_000, nbv: 0 })
    // Beside the booked pack, it adds to Planned and nothing else.
    expect(fleetTotals([...PACK, plan], AFTER_12)).toMatchObject({ cost: 1_305_000, planned: 335_000, nbv: 1_070_100 })
    const html = register({ assets: [...PACK, plan] })
    expect(html).toMatch(/data-asset="plan"[\s\S]*?data-cost=""[\s\S]*?data-planned="335000"[\s\S]*?data-nbv=""/)
    expect(html).toContain(`data-total="planned">${money(335_000)}`)
    expect(html).toContain(`data-total="nbv">${money(1_070_100)}`)
  })

  it('adds capitalized costs to cost and NBV', () => {
    const a = asset({ hardware_cost: 335_000, salvage_value: 33_500, capitalized_costs: 12_000 })
    expect(assetFigures(a, AFTER_12)).toMatchObject({ cost: 347_000, nbv: 286_700 })
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

  it('the real dialog takes one key per opening: whileOpen mounts its body on open, and not while closed', () => {
    // Each static render is a fresh mount, exactly what reopening the dialog is (whileOpen unmounts
    // the body on close). The submitter, and so the key, is made once per mount.
    let n = 0
    const newKey = () => `key-${++n}`
    const render = (open: boolean) => renderToStaticMarkup(
      <CurrencyProvider currency="USD">
        <CapexDialog open={open} onOpenChange={() => {}} fetcher={async () => new Response('{}')} onDone={() => {}} asset={PACK[0]} newKey={newKey} />
      </CurrencyProvider>,
    )
    render(false)
    expect(n).toBe(0)
    render(true)
    expect(n).toBe(1)
    render(true)
    expect(n).toBe(2)
  })

  it('a probe through the same whileOpen and hook sees the key held for the mount and renewed on the next', () => {
    let n = 0
    const Probe = whileOpen(function Probe(p: { open: boolean; onOpenChange: () => void; fetcher: Fetcher; onDone: () => void }) {
      const s = useCapexSubmitter(p.fetcher, 'h200', () => `key-${++n}`)
      return <i>{s.key()}|{s.key()}</i>
    })
    const props = { onOpenChange: () => {}, fetcher: (async () => new Response('{}')) as Fetcher, onDone: () => {} }
    expect(renderToStaticMarkup(<Probe open={false} {...props} />)).toBe('')
    expect(renderToStaticMarkup(<Probe open {...props} />)).toBe('<i>key-1|key-1</i>')
    expect(renderToStaticMarkup(<Probe open {...props} />)).toBe('<i>key-2|key-2</i>')
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

  it('shows a stored instant back as the same wall-clock time it was entered at', () => {
    expect(utcToLocalLabel(localToUtc('2026-03-01T10:00'))).toBe('2026-03-01 10:00')
    expect(nowLocalInput(new Date(2026, 2, 1, 9, 5))).toBe('2026-03-01T09:05')
  })
})

describe('the asset’s depreciation schedule', () => {
  // The plan's P1b fixture: the $1,305,000 fleet as one server, 60 months, 10% salvage.
  const fleet = asset({ hardware_cost: 1_305_000, salvage_value: 130_500 })

  it('has 60 rows and ends at salvage, NBV 130,500 at month 60', () => {
    const lines = assetSchedule(fleet)
    expect(lines).toHaveLength(60)
    const html = renderToStaticMarkup(<CurrencyProvider currency="USD"><DepreciationTable lines={lines} convention="full_month" lifeMonths={60} /></CurrencyProvider>)
    expect(html.match(/data-month="/g)).toHaveLength(60)
    expect(html).toMatch(/data-month="60"[\s\S]*?data-nbv="130500"/)
    expect(html).toMatch(/data-month="1"[\s\S]*?data-nbv="1285425"/)
  })

  it('takes today as the local calendar date, not the UTC one', () => {
    const d = new Date()
    const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    expect(todayIso()).toBe(local)
  })

  it('marks the final-month true-up when rounding leaves a different last charge', () => {
    const odd = asset({ hardware_cost: 1_000, salvage_value: 0, useful_life_months: 3 })
    const lines = assetSchedule(odd)
    expect(lines.map(l => l.amount)).toEqual([333.33, 333.33, 333.34])
    const html = renderToStaticMarkup(<CurrencyProvider currency="USD"><DepreciationTable lines={lines} convention="full_month" lifeMonths={3} /></CurrencyProvider>)
    expect(html).toContain('final-month true-up')
  })

  const table = (a: GpuAsset) => renderToStaticMarkup(
    <CurrencyProvider currency="USD"><DepreciationTable lines={assetSchedule(a)} convention={a.depreciation_convention} lifeMonths={a.useful_life_months} /></CurrencyProvider>,
  )

  it('mid_month: half months at both ends are the plan, not a true-up', () => {
    const even = asset({ hardware_cost: 1_000, salvage_value: 0, useful_life_months: 3, depreciation_convention: 'mid_month' })
    const lines = assetSchedule(even)
    expect(lines.map(l => l.amount)).toEqual([166.67, 333.33, 333.33, 166.67])
    expect(trueUpIndex(lines, 'mid_month', 3)).toBeNull()
    expect(table(even)).not.toContain('final-month true-up')
  })

  it('mid_month: a last half month that differs from half a regular month is the true-up', () => {
    const odd = asset({ hardware_cost: 1_000, salvage_value: 0, useful_life_months: 7, depreciation_convention: 'mid_month' })
    const lines = assetSchedule(odd)
    expect(lines).toHaveLength(8)
    expect(lines[7].amount).toBe(71.41)
    expect(trueUpIndex(lines, 'mid_month', 7)).toBe(7)
    expect(table(odd)).toMatch(/data-month="8"[\s\S]*?final-month true-up/)
  })

  it('a schedule cut short by disposal has no true-up: its last line is the disposal month', () => {
    const sold = asset({ hardware_cost: 1_000, salvage_value: 0, useful_life_months: 7, status: 'disposed', disposed_on: '2026-03-15' })
    const lines = assetSchedule(sold)
    expect(lines).toHaveLength(3)
    expect(trueUpIndex(lines, 'full_month', 7)).toBeNull()
    expect(table(sold)).not.toContain('final-month true-up')
  })
})

describe('the firm-wide overview', () => {
  const vehicles = [{ id: 'v1', name: 'H200 SPV I', active: true }, { id: 'v2', name: 'B300 SPV II', active: true }]
  const view = (loaded: Parameters<typeof FleetOverviewView>[0]['loaded']) => renderToStaticMarkup(
    <CurrencyProvider currency="USD"><FleetOverviewView vehicles={vehicles} loaded={loaded} asOf={AFTER_12} /></CurrencyProvider>,
  )

  it('shows a vehicle that failed to load on its own card, and says the totals are partial', () => {
    const html = view({ v1: { assets: PACK }, v2: { error: 'Could not read the record' } })
    expect(html).toMatch(/data-vehicle="v2"[\s\S]*?role="alert"[^>]*>Could not read the record</)
    expect(html).toContain('Partial: 1 vehicle could not be loaded')
    expect(html).toContain(money(1_070_100))
  })

  it('totals every vehicle when all load, with planned cost said apart', () => {
    const plan = asset({ id: 'plan', status: 'planned', purchase_entry_id: null, hardware_cost: 335_000 })
    const html = view({ v1: { assets: PACK }, v2: { assets: [plan] } })
    expect(html).not.toContain('Partial')
    expect(html).toContain(`Booked; ${money(335_000)} more planned`)
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
