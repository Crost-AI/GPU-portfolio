import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * The performance view is a client component the server still renders, in UTC. Its first render
 * has to produce the same HTML in the browser, whatever the user's time zone, or hydration fails;
 * the user's own quarter replaces it after mount. Pinned at an instant where the local and UTC
 * days fall in different quarters: 2026-03-30 23:30 in Los Angeles is already 2026-03-31 in UTC.
 */
vi.mock('@/components/currency-context', () => ({ useCurrency: () => 'USD' }))
vi.mock('@/components/accounting-vehicle', () => ({ useLedgerFetch: () => fetch, useVehicle: () => ({ group: null }) }))

import { FundPerformanceView } from '@/app/(app)/funds/performance/view'

const originalTz = process.env.TZ
afterEach(() => {
  vi.useRealTimers()
  process.env.TZ = originalTz
})

function firstRender(tz: string) {
  process.env.TZ = tz
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-03-31T06:30:00Z'))
  return renderToStaticMarkup(createElement(FundPerformanceView))
}

describe('the fund performance view', () => {
  it('renders the same first HTML in every time zone, so it hydrates', () => {
    const server = firstRender('UTC')
    expect(server).toContain('value="2026-03-31" selected')
    for (const tz of ['America/Los_Angeles', 'Asia/Tokyo']) expect(firstRender(tz)).toBe(server)
  })
})
