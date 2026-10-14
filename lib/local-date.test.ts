import { afterEach, describe, expect, it, vi } from 'vitest'
import { toLocalIsoDate, todayLocalIso } from './local-date'

/**
 * A default entry date is the user's calendar day, not UTC's. Written to pass in any TZ the suite
 * runs under: each assertion reads the Date's own local fields rather than a fixed offset.
 */
afterEach(() => vi.useRealTimers())

describe('toLocalIsoDate', () => {
  it("reads the local calendar day, late in the evening as much as at noon", () => {
    const lateEvening = new Date(2026, 2, 31, 23, 30)
    expect(toLocalIsoDate(lateEvening)).toBe('2026-03-31')
    // West of UTC, the UTC date has already turned over — the bug this replaces.
    if (lateEvening.getTimezoneOffset() > 30) expect(lateEvening.toISOString().slice(0, 10)).toBe('2026-04-01')

    const justAfterMidnight = new Date(2026, 3, 1, 0, 15)
    expect(toLocalIsoDate(justAfterMidnight)).toBe('2026-04-01')
    if (justAfterMidnight.getTimezoneOffset() < -15) expect(justAfterMidnight.toISOString().slice(0, 10)).toBe('2026-03-31')
  })

  it('zero-pads the month and day', () => {
    expect(toLocalIsoDate(new Date(2026, 0, 5, 12))).toBe('2026-01-05')
  })
})

describe('todayLocalIso', () => {
  it("is now's local calendar day", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 2, 31, 23, 30))
    expect(todayLocalIso()).toBe('2026-03-31')
  })
})
