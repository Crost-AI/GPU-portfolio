// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

/**
 * The statement package on screen: the Statements page and the MCP statements view. Every kind but
 * a GPU SPV renders exactly as before: these pins were committed against both views as they stood
 * before the investing section and the fleet schedule reached them. A GPU SPV's shows its
 * equipment as investing, so the sections on screen add up to the net change, and its fleet schedule.
 *
 * This file opts into happy-dom by the comment on its first line; every other test stays on node.
 */

import { AccessProvider, type ClientAccess } from '@/components/access-context'
import { CurrencyProvider } from '@/components/currency-context'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { StatementsView } from '@/app/(app)/funds/statements/view'
import { buildStatementPackageFromData } from '@/lib/accounting/statement-package'
import { renderView, type StatementTab, type ViewContext } from '@/lib/mcp-apps/app/views'
import { createFormatters } from '@/lib/mcp-apps/app/format'
import { statements as SAMPLE } from '@/lib/mcp-apps/fixtures'
import type { StatementsPayload } from '@/lib/mcp-apps/payload'
import { gpuLedger, vcLedger } from '@/tests/helpers/statement-fixtures'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/funds/v1/statements',
  useSearchParams: () => new URLSearchParams(),
}))

// Vitest globals are off, so Testing Library cannot register its own cleanup.
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const ACCESS: ClientAccess = {
  role: 'member',
  features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone' } as FeatureVisibilityMap,
  grants: { accounting: 'read' },
  defaults: {},
}

/**
 * The statements route's JSON for a ledger, as the page fetches it: the year 2027, or (compared) its
 * second half with the first beside it — a custom window's comparison is the window of the same
 * length before it, and the year's would end before the ledger starts.
 */
const routeJson = (data: ReturnType<typeof vcLedger>, compared = false) => {
  const pkg = buildStatementPackageFromData(data, new URLSearchParams(compared
    ? { preset: 'custom', start: '2027-07-01', end: '2027-12-31', compare: '1' }
    : { preset: 'custom', start: '2027-01-01', end: '2027-12-31' }))
  if (compared) expect(pkg.comparisons?.map(c => c.period.end)).toEqual(['2027-06-30'])
  return JSON.parse(JSON.stringify(pkg.comparisons ? { ...pkg.payload, comparisons: pkg.comparisons } : pkg.payload))
}

async function mountPage(json: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } })))
  const { container } = render(
    <AccessProvider value={ACCESS}><CurrencyProvider currency="USD"><StatementsView /></CurrencyProvider></AccessProvider>,
  )
  await screen.findByText('Statement of cash flows')
  return container
}

const viewCtx = (tab: StatementTab): ViewContext => ({
  fmt: createFormatters('USD', 'en-US'), compact: false, canExpand: false, expand() {}, open() {}, onDispose() {},
  statementTab: tab, setStatementTab() {}, ask: async () => true,
})
const mcpHtml = (payload: StatementsPayload, tab: StatementTab) => {
  const root = document.createElement('div')
  root.append(...renderView(payload, viewCtx(tab)))
  return root.innerHTML
}

describe('a fund: the Statements page is unchanged', () => {
  it('one period', async () => {
    expect((await mountPage(routeJson(vcLedger()))).innerHTML).toMatchSnapshot()
  })
  it('with a comparison', async () => {
    expect((await mountPage(routeJson(vcLedger(), true))).innerHTML).toMatchSnapshot()
  })
})

describe('a fund: the MCP statements view is unchanged', () => {
  it('every tab', () => {
    for (const tab of ['balance', 'income', 'cash', 'capital'] as const) expect(mcpHtml(SAMPLE, tab), tab).toMatchSnapshot()
  })
})

/** "$1,234.50" / "-$1,234.50" / "($1,234.50)" → a number. */
const parseMoney = (t: string | null) => {
  const v = (t ?? '').trim()
  const n = Number(v.replace(/[^0-9.]/g, ''))
  return /^[-(]|^\$?-/.test(v) ? -n : n
}
/** A table row's first numeric cell, found by its label. */
const rowFigure = (container: HTMLElement, label: string) => {
  const tr = Array.from(container.querySelectorAll('tr')).find(r => r.querySelector('td, th')?.textContent?.trim() === label)
  expect(tr, label).toBeTruthy()
  return parseMoney(tr!.querySelectorAll('td')[1]?.textContent ?? null)
}

describe("a GPU SPV: the Statements page shows investing, foots, and shows the fleet schedule", () => {
  it('purchases and disposal proceeds are two rows under investing, and the sections add up to the net change', async () => {
    const page = await mountPage(routeJson(gpuLedger()))
    expect(screen.getByText('Investing activities')).toBeTruthy()
    expect(screen.getByText('Purchases of equipment and capitalized costs')).toBeTruthy()
    expect(screen.getByText('Proceeds from disposal of equipment')).toBeTruthy()
    const [op, inv, fin, net] = ['Total Operating activities', 'Total Investing activities', 'Total Financing activities', 'Net change in cash'].map(l => rowFigure(page, l))
    expect(inv).toBe(-372_000)
    expect(op + inv + fin).toBe(net)
    expect(net).toBe(648_000)
  })

  it('compared: the disposal (H2) and the purchases (H1) are separate rows, and each column foots', async () => {
    const page = await mountPage(routeJson(gpuLedger(), true))
    const cells = (label: string) => {
      const tr = Array.from(page.querySelectorAll('tr')).find(r => r.querySelector('td')?.textContent?.trim() === label)!
      return Array.from(tr.querySelectorAll('td')).slice(1).map(td => (td.textContent?.trim() ? parseMoney(td.textContent) : null))
    }
    expect(cells('Proceeds from disposal of equipment')).toEqual([50_000, null])
    expect(cells('Purchases of equipment and capitalized costs')).toEqual([null, -422_000])
    const [op, inv, fin, net] = ['Total Operating activities', 'Total Investing activities', 'Total Financing activities', 'Net change in cash'].map(cells)
    for (const c of [0, 1]) expect(op[c]! + inv[c]! + fin[c]!, `column ${c}`).toBe(net[c])
  })

  it('the fleet schedule lists the server still held and totals the net equipment', async () => {
    const page = await mountPage(routeJson(gpuLedger()))
    expect(screen.getByText('Fleet schedule')).toBeTruthy()
    expect(screen.getByText('GPU equipment at cost — srv-2')).toBeTruthy()
    expect(screen.queryByText('GPU equipment at cost — srv-1')).toBeNull()
    const total = Array.from(page.querySelectorAll('tr')).find(r => r.textContent?.startsWith('Total equipment, net'))!
    expect(Array.from(total.querySelectorAll('td')).slice(1).map(td => parseMoney(td.textContent))).toEqual([335_000, -5_000, 330_000])
  })
})

describe("a GPU SPV: the MCP statements view shows investing and a fleet schedule tab", () => {
  const GPU: StatementsPayload = {
    ...SAMPLE,
    data: {
      ...SAMPLE.data,
      cashFlows: {
        operating: { label: 'Operating activities', rows: [{ name: 'Revenue', amount: 20_000 }], total: 20_000 },
        investing: { label: 'Investing activities', rows: [{ name: 'Purchases of equipment and capitalized costs', amount: -422_000 }, { name: 'Proceeds from disposal of equipment', amount: 50_000 }], total: -372_000 },
        financing: { label: 'Financing activities', rows: [{ name: 'Capital contributions', amount: 1_000_000 }], total: 1_000_000 },
        netChange: 648_000, openingCash: 0, endingCash: 648_000,
      },
      fleetSchedule: [{ name: 'srv-2', type: 'NVIDIA B200', gpus: 8, inServiceDate: null, cost: 335_000, accumulated: 5_000, nbv: 330_000 }],
    },
  }

  it('the cash tab: investing between operating and financing, and the sections add up to the net change', () => {
    const root = document.createElement('div')
    root.innerHTML = mcpHtml(GPU, 'cash')
    const text = root.textContent ?? ''
    expect(text.indexOf('Investing activities')).toBeGreaterThan(text.indexOf('Total operating activities'))
    expect(text.indexOf('Financing activities')).toBeGreaterThan(text.indexOf('Total investing activities'))
    const fig = (label: string) => parseMoney(Array.from(root.querySelectorAll('tr')).find(r => r.querySelector('th')?.textContent === label)!.querySelector('td')!.textContent)
    expect(fig('Total operating activities') + fig('Total investing activities') + fig('Total financing activities')).toBe(fig('Net change in cash'))
  })

  it('the fleet schedule tab: one row per server and the net total', () => {
    const root = document.createElement('div')
    root.innerHTML = mcpHtml(GPU, 'fleet')
    expect(root.textContent).toContain('Fleet schedule')
    expect(root.textContent).toContain('srv-2')
    expect(root.textContent).toContain('Total equipment, net')
    expect(root.textContent).toContain('$330,000')
  })

  it('a fund has no fleet schedule tab, and asking for it shows the balance sheet', () => {
    expect(mcpHtml(SAMPLE, 'fleet')).not.toContain('Fleet schedule')
    expect(mcpHtml(SAMPLE, 'fleet')).toBe(mcpHtml(SAMPLE, 'balance'))
  })
})
