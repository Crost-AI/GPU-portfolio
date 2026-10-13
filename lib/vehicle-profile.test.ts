import { describe, it, expect } from 'vitest'
import { EMPTY_PROFILE, lpReportingDueDate, parseProfilePatch, profileFromRow } from './vehicle-profile'

describe('parseProfilePatch', () => {
  it('takes camelCase or snake_case keys and leaves absent ones alone', () => {
    expect(parseProfilePatch({ strategy: 'venture', lpReportDaysQuarterly: 45 })).toEqual({ update: { strategy: 'venture', lp_report_days_quarterly: 45 } })
    expect(parseProfilePatch({ lp_report_days_annual: '120' })).toEqual({ update: { lp_report_days_annual: 120 } })
    expect(parseProfilePatch({})).toEqual({ update: {} })
  })

  it('clears a field on null or an empty string', () => {
    expect(parseProfilePatch({ strategy: '', administrator: null, lp_report_days_quarterly: null }))
      .toEqual({ update: { strategy: null, administrator: null, lp_report_days_quarterly: null } })
  })

  it('trims the administrator and refuses one that is too long', () => {
    expect(parseProfilePatch({ administrator: '  Acme Fund Services ' })).toEqual({ update: { administrator: 'Acme Fund Services' } })
    expect(parseProfilePatch({ administrator: 'x'.repeat(201) })).toHaveProperty('error')
  })

  it('refuses an unknown strategy and a day count outside 1 to 365', () => {
    expect(parseProfilePatch({ strategy: 'hedge' })).toHaveProperty('error')
    for (const bad of [0, 366, 1.5, 'soon']) expect(parseProfilePatch({ lpReportDaysQuarterly: bad }), String(bad)).toHaveProperty('error')
  })
})

describe('lpReportingDueDate', () => {
  const profile = { ...EMPTY_PROFILE, lpReportDaysQuarterly: 45, lpReportDaysAnnual: 90 }

  it('counts the quarterly window from a March, June or September quarter-end', () => {
    expect(lpReportingDueDate(profile, '2026-09-30')).toBe('2026-11-14')
    expect(lpReportingDueDate(profile, '2026-03-31')).toBe('2026-05-15')
  })

  it('uses the annual window for the December quarter-end, across the year', () => {
    expect(lpReportingDueDate(profile, '2026-12-31')).toBe('2027-03-31')
  })

  it('is null when the profile does not say', () => {
    expect(lpReportingDueDate(EMPTY_PROFILE, '2026-09-30')).toBeNull()
    expect(lpReportingDueDate({ ...EMPTY_PROFILE, lpReportDaysQuarterly: 45 }, '2026-12-31')).toBeNull()
  })
})

describe('profileFromRow', () => {
  it('drops a strategy the app does not know and a blank administrator', () => {
    expect(profileFromRow({ strategy: 'hedge', administrator: '  ', lp_report_days_quarterly: 30 }))
      .toEqual({ strategy: null, administrator: null, lpReportDaysQuarterly: 30, lpReportDaysAnnual: null })
  })
})
