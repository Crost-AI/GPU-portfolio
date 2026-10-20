// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

/**
 * ── GPU fleet (P5) ── The Revenue & payouts page in a real mount (P5-4).
 *
 * The static tests in gpu-revenue-ui.test.tsx check each region and request body; these drive the
 * page itself: select a staged row, Post, get `needsReversal`, confirm in the dialog, and the re-send
 * carries `confirmReversal: true`; and type a server's figures into the entry form and stage them.
 *
 * This file opts into happy-dom by the comment on its first line; every other test stays on node.
 */

import { AccessProvider, type ClientAccess } from '@/components/access-context'
import { CurrencyProvider } from '@/components/currency-context'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { RevenueView } from '@/components/gpu/revenue-view'

// Vitest globals are off, so Testing Library cannot register its own cleanup.
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const ACCESS: ClientAccess = {
  role: 'member',
  features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', gpu_fleet: 'everyone' } as FeatureVisibilityMap,
  grants: { fleet: 'write', accounting: 'write' },
  defaults: {},
}

const ASSETS = [{ id: 'h1', name: 'H200 #1', gpu_count: 8, status: 'in_service' }]
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, runId: 'r', assetId: 'h1', assetName: 'H200 #1', assetRef: 'H200 #1', periodStart: '2026-09-01', periodEnd: '2026-09-30',
  gpuHoursRented: 4320, utilizationPct: 75, gross: 8640, fee: 864, net: 7776, downtimeHours: 0, note: null, currency: 'USD',
  status: 'staged', supersedesId: null, entryId: null, ...over,
})
const EARNINGS = [row('new', { supersedesId: 'old', gross: 9000, net: 8136 }), row('old', { status: 'posted', entryId: 'je-old' })]
const PAYOUTS = { payouts: [], receivable: { asOf: '2026-10-20', ledger1150: 7776, postedNet: 7776, matchedPayouts: 0, expected: 7776, difference: 0 } }

/** Answers by route and method; the POSTs to the earnings and import routes take their replies in order. */
function server(posts: Record<string, unknown[]>) {
  const sent: { path: string; body: any }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (init?.method === 'POST') {
      sent.push({ path, body })
      const key = path.split('?')[0]
      return json(posts[key]?.shift() ?? {})
    }
    if (path.startsWith('/api/fleet/assets')) return json({ assets: ASSETS })
    if (path.startsWith('/api/fleet/ops/earnings')) return json({ rows: EARNINGS })
    if (path.startsWith('/api/fleet/ops/payouts')) return json(PAYOUTS)
    return json({})
  }))
  return sent
}

const mount = () => render(
  <AccessProvider value={ACCESS}>
    <CurrencyProvider currency="USD"><RevenueView vehicle="GPU SPV I" vehicleId="v1" /></CurrencyProvider>
  </AccessProvider>,
)

describe('the Revenue & payouts page', () => {
  it('Post on a row that replaces a posted period asks first, then re-sends with confirmReversal', async () => {
    const sent = server({
      '/api/fleet/ops/earnings': [
        { needsReversal: [{ id: 'new', supersedesId: 'old', entryId: 'je-old', entryDate: '2026-09-30' }] },
        { posted: [{ id: 'new', entryId: 'je-new' }], reversed: [{ id: 'old', reversalId: 'rev' }] },
      ],
    })
    mount()
    fireEvent.click(await screen.findByLabelText('Select H200 #1 2026-09-01 to 2026-09-30'))
    fireEvent.click(screen.getByRole('button', { name: 'Post selected' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Reverse the posted periods?')).toBeTruthy()
    expect(dialog.textContent).toContain('2026-09-30')
    expect(sent).toHaveLength(1)
    expect(sent[0].body).toEqual({ action: 'post', ids: ['new'], group: 'GPU SPV I' })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Reverse and post' }))
    await waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1].body).toEqual({ action: 'post', ids: ['new'], confirmReversal: true, group: 'GPU SPV I' })
    expect(await screen.findByText(/Posted 1 period, reversing 1 posted entry first/)).toBeTruthy()
  })

  it('Cancel in the confirmation sends nothing more', async () => {
    const sent = server({ '/api/fleet/ops/earnings': [{ needsReversal: [{ id: 'new', supersedesId: 'old', entryId: 'je-old', entryDate: '2026-09-30' }] }] })
    mount()
    fireEvent.click(await screen.findByLabelText('Select H200 #1 2026-09-01 to 2026-09-30'))
    fireEvent.click(screen.getByRole('button', { name: 'Post selected' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(sent).toHaveLength(1)
  })

  it('typing a server’s figures stages them as one ManualRow for the period shown', async () => {
    const sent = server({ '/api/fleet/ops/import': [{ imported: 1, skipped: 0, needsReview: 0, skippedRows: [], errors: [], runId: 'r', staged: [{ id: 'x', status: 'staged' }] }] })
    mount()
    const hours = await screen.findByLabelText('H200 #1: rented GPU-hours')
    const start = (screen.getByLabelText('Period start') as HTMLInputElement).value
    const end = (screen.getByLabelText('Period end') as HTMLInputElement).value
    fireEvent.change(hours, { target: { value: '4320' } })
    fireEvent.change(screen.getByLabelText('H200 #1: gross'), { target: { value: '8640' } })
    fireEvent.change(screen.getByLabelText('H200 #1: fee'), { target: { value: '864' } })
    // Net left blank: worked out as gross less fee, shown as its placeholder.
    expect((screen.getByLabelText('H200 #1: net') as HTMLInputElement).placeholder).toBe('7776.00')
    fireEvent.click(screen.getByRole('button', { name: 'Stage entries' }))
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].path).toBe('/api/fleet/ops/import?group=GPU%20SPV%20I')
    expect(sent[0].body).toEqual({
      group: 'GPU SPV I',
      rows: [{ assetId: 'h1', period_start: start, period_end: end, rented_hours: 4320, gross: 8640, fee: 864, net: 7776 }],
    })
    expect(await screen.findByRole('status')).toBeTruthy()
  })
})
