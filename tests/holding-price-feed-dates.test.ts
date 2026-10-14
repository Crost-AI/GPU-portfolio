import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultMarksDate, marksRequestUrl } from '@/app/(app)/companies/[id]/holding-price-feed'

/**
 * The price feed opens on the user's day, but the route defaults ?asOf= to the UTC day and refuses
 * a mark dated after it. Leaving asOf off whenever it was "today" made a Los Angeles user at 23:30
 * on March 31 see March 31 in the picker while the route computed — and Book submitted — April 1.
 *
 * Node reads process.env.TZ afresh, so each case pins a zone and an instant on either side of the
 * UTC day boundary. The route's two rules are restated here: the marks date is ?asOf= or the UTC
 * day, and the GET echoes it back as the date Book then submits.
 */
const URL_ = '/api/companies/c1/price-feed'
const routeAsOf = (requestUrl: string, utcNow: Date) =>
  new URL(requestUrl, 'https://fund.test').searchParams.get('asOf') || utcNow.toISOString().slice(0, 10)

const originalTz = process.env.TZ
afterEach(() => {
  vi.useRealTimers()
  process.env.TZ = originalTz
})

function at(tz: string, instant: Date) {
  process.env.TZ = tz
  vi.useFakeTimers()
  vi.setSystemTime(instant)
  return instant
}

describe('the price feed marks date', () => {
  it('in Los Angeles at 23:30, asks for and books the local day, not UTC tomorrow', () => {
    const now = at('America/Los_Angeles', new Date('2026-04-01T06:30:00Z')) // 2026-03-31 23:30 PDT
    const asOf = defaultMarksDate()
    expect(asOf).toBe('2026-03-31')
    const request = marksRequestUrl(URL_, asOf)
    expect(request).toBe(`${URL_}?asOf=2026-03-31`)
    const booked = routeAsOf(request, now)
    expect(booked).toBe('2026-03-31')
    expect(booked <= now.toISOString().slice(0, 10)).toBe(true) // not refused as future-dated
  })

  it("in Tokyo early in the morning, does not open on a day the route would refuse as future", () => {
    const now = at('Asia/Tokyo', new Date('2026-03-31T23:00:00Z')) // 2026-04-01 08:00 JST
    const asOf = defaultMarksDate()
    expect(asOf).toBe('2026-03-31')
    const request = marksRequestUrl(URL_, asOf)
    expect(request).toBe(`${URL_}?asOf=2026-03-31`)
    const booked = routeAsOf(request, now)
    expect(booked).toBe('2026-03-31')
    expect(booked <= now.toISOString().slice(0, 10)).toBe(true) // not refused as future-dated
  })

  it("sends the date even when it is the route's own default", () => {
    const now = at('UTC', new Date('2026-03-31T12:00:00Z'))
    const asOf = defaultMarksDate()
    expect(asOf).toBe('2026-03-31')
    expect(marksRequestUrl(URL_, asOf)).toBe(`${URL_}?asOf=2026-03-31`)
    expect(routeAsOf(marksRequestUrl(URL_, asOf), now)).toBe('2026-03-31')
  })

  it('always sends a date the user picked', () => {
    at('America/Los_Angeles', new Date('2026-04-01T06:30:00Z'))
    expect(marksRequestUrl(URL_, '2025-12-31')).toBe(`${URL_}?asOf=2025-12-31`)
  })
})
