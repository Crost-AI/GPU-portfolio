// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

/**
 * The statement package on screen: the Statements page and the MCP statements view. Every kind but
 * a GPU SPV renders exactly as before: these pins were committed against both views as they stood
 * before the investing section and the fleet schedule reached them.
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
import { vcLedger } from '@/tests/helpers/statement-fixtures'

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
