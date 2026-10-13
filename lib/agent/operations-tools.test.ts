// The quarter-end operations tools: what the registry exposes, under which grant, and that each
// read is cut to the caller's entities.

import { describe, it, expect } from 'vitest'
import { getTool, isLedgerTool, accessDomainFor, accessFeatureFor } from '@/lib/accounting/agent-tools'
import { accessContextFrom } from '@/lib/access/effective'
import { loadCloseStatus } from '@/lib/accounting/close-status'
import { canSeeVehicle } from '@/lib/access/scope'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { OPERATIONS_HANDLERS } from './operations-tools'

const access = (vehicles: { all: boolean; ids: string[] }, role: 'admin' | 'member' = 'member') => accessContextFrom({
  fundId: 'f1', userId: 'u1', role, features: {} as any,
  grants: [{ domain: 'accounting', level: 'write' }, { domain: 'portfolio', level: 'read' }, { domain: 'compliance', level: 'read' }],
  defaults: [], vehicles,
})
const everything = access({ all: true, ids: [] })
const fundIOnly = access({ all: false, ids: ['v1'] })

const ctx = (admin: any, a = everything, portfolioGroup = '') => ({ admin, fundId: 'f1', portfolioGroup, userId: 'u1', access: a })

const vehicles = [
  { id: 'v1', fund_id: 'f1', name: 'Fund I', kind: 'fund', active: true, aliases: [], strategy: 'venture', administrator: 'Acme Fund Services', lp_report_days_quarterly: 45, lp_report_days_annual: 90 },
  { id: 'v2', fund_id: 'f1', name: 'Fund II', kind: 'fund', active: true, aliases: [], strategy: null, administrator: null, lp_report_days_quarterly: null, lp_report_days_annual: null },
]

describe('operations tools in the registry', () => {
  it('acts on one entity for the profile and the close approval, and on the fund for the rest', () => {
    for (const name of ['entity_profile', 'set_entity_profile', 'approve_close']) {
      const tool = getTool(name)!
      expect(isLedgerTool(tool), name).toBe(true)
      expect(tool.inputSchema.properties.vehicle, name).toBeTruthy()
      expect(accessDomainFor(tool), name).toBe('accounting')
    }
    for (const name of ['close_status', 'data_request_status', 'compliance_calendar', 'lp_delivery_log', 'whats_due']) {
      const tool = getTool(name)!
      expect(isLedgerTool(tool), name).toBe(false)
      expect(tool.scope, name).toBe('read')
    }
    expect(getTool('set_entity_profile')!.scope).toBe('write')
    expect(getTool('approve_close')!.scope).toBe('write')
  })

  it('gates each fund-wide read like the web page it mirrors', () => {
    const gate = (name: string) => [accessDomainFor(getTool(name)!), accessFeatureFor(getTool(name)!)]
    expect(gate('close_status')).toEqual(['accounting', undefined])
    expect(gate('data_request_status')).toEqual(['portfolio', 'asks'])
    expect(gate('compliance_calendar')).toEqual(['compliance', undefined])
    expect(gate('lp_delivery_log')).toEqual(['lp_relations', 'lp_portal'])
  })
})

describe('entity_profile / set_entity_profile', () => {
  it('reads and writes the profile of the resolved entity', async () => {
    const { admin, tables } = memoryAdmin({ fund_vehicles: vehicles })
    expect(await OPERATIONS_HANDLERS.entity_profile(ctx(admin, everything, 'Fund I'), {})).toEqual({
      vehicle: 'Fund I', strategy: 'venture', administrator: 'Acme Fund Services', lpReportDaysQuarterly: 45, lpReportDaysAnnual: 90,
    })
    const out = await OPERATIONS_HANDLERS.set_entity_profile(ctx(admin, everything, 'Fund II'),
      { vehicle: 'Fund II', strategy: 'buyout', administrator: 'In-house', lp_report_days_quarterly: 60 })
    expect(out).toMatchObject({ vehicle: 'Fund II', strategy: 'buyout', administrator: 'In-house', lpReportDaysQuarterly: 60, lpReportDaysAnnual: null })
    expect(tables.fund_vehicles.find(v => v.id === 'v1')!.strategy).toBe('venture')
  })

  it('refuses an empty change and a bad value', async () => {
    const { admin } = memoryAdmin({ fund_vehicles: vehicles })
    await expect(OPERATIONS_HANDLERS.set_entity_profile(ctx(admin, everything, 'Fund I'), { vehicle: 'Fund I' })).rejects.toThrow(/Nothing to change/)
    await expect(OPERATIONS_HANDLERS.set_entity_profile(ctx(admin, everything, 'Fund I'), { lp_report_days_annual: 400 })).rejects.toThrow(/1 to 365/)
  })
})

describe('approve_close', () => {
  it('needs a person behind the credential and a date', async () => {
    const { admin } = memoryAdmin({ fund_vehicles: vehicles })
    await expect(OPERATIONS_HANDLERS.approve_close({ ...ctx(admin, everything, 'Fund I'), userId: null }, { through: '2026-09-30' })).rejects.toThrow(/needs a person/)
    await expect(OPERATIONS_HANDLERS.approve_close(ctx(admin, everything, 'Fund I'), {})).rejects.toThrow(/through/)
    await expect(OPERATIONS_HANDLERS.approve_close(ctx(admin, everything, 'Fund I'), { through: '2026-02-31' })).rejects.toThrow(/real date/)
  })
})

describe('close_status', () => {
  const seed = () => memoryAdmin({
    fund_vehicles: vehicles,
    journal_entries: [
      { id: 'j1', fund_id: 'f1', vehicle_id: 'v1', book: 'actual', status: 'posted', entry_date: '2026-01-15' },
      { id: 'j2', fund_id: 'f1', vehicle_id: 'v2', book: 'actual', status: 'posted', entry_date: '2026-02-01' },
    ],
    fiscal_periods: [{ id: 'p1', fund_id: 'f1', vehicle_id: 'v1', period_start: '2026-07-01', period_end: '2026-09-30', status: 'closed' }],
    close_reviews: [{ id: 'r1', fund_id: 'f1', vehicle_id: 'v1', fiscal_period_id: 'p1', status: 'prepared', prepared_by: 'u2', approved_by: null, approved_at: null }],
    close_review_checks: [
      { id: 'k1', close_review_id: 'r1', section: 'Cash', label: 'Bank reconciled', status: 'passed', detail: null, sort_order: 1 },
      { id: 'k2', close_review_id: 'r1', section: 'Investments', label: 'Valuations current', status: 'needs_review', detail: '2 marks older than a quarter', sort_order: 2 },
    ],
  })

  it("puts the close, its review, the open checks and the LP reporting date side by side", async () => {
    const { admin } = seed()
    const out = await loadCloseStatus(admin, 'f1', { includeManco: false }, new Date('2026-10-13T12:00:00Z'))
    if ('error' in out) throw new Error(out.error)
    expect(out.quarterEnd).toBe('2026-09-30')
    expect(out.label).toBe('Q3 2026')
    const [one, two] = out.entities
    expect(one).toMatchObject({
      vehicle: 'Fund I', close: 'closed', review: 'prepared', preparedBy: 'u2', approvedBy: null,
      openChecks: [{ label: 'Valuations current', section: 'Investments', status: 'needs_review', detail: '2 marks older than a quarter' }],
      lpReportingDue: '2026-11-14', daysUntilLpReporting: 32,
    })
    expect(two).toMatchObject({ vehicle: 'Fund II', review: 'none', openChecks: [], lpReportingDue: null })
    expect(['due', 'late']).toContain(two.close)
  })

  it("shows a scoped member only their entities, and refuses a quarter it can't answer for", async () => {
    const { admin } = seed()
    const out = await loadCloseStatus(admin, 'f1', { includeManco: false, visible: id => canSeeVehicle(fundIOnly, id) }, new Date('2026-10-13T12:00:00Z'))
    if ('error' in out) throw new Error(out.error)
    expect(out.entities.map(e => e.vehicle)).toEqual(['Fund I'])
    const bad = await loadCloseStatus(admin, 'f1', { includeManco: false, quarterEnd: '2026-08-31' }, new Date('2026-10-13T12:00:00Z'))
    expect(bad).toHaveProperty('error')
    const hidden = await loadCloseStatus(admin, 'f1', { includeManco: false, visible: id => canSeeVehicle(fundIOnly, id), vehicle: 'Fund II' }, new Date('2026-10-13T12:00:00Z'))
    expect(hidden).toHaveProperty('error')
  })
})

describe('data_request_status', () => {
  it("answers for the caller's companies only", async () => {
    const { admin } = memoryAdmin({
      fund_vehicles: vehicles,
      companies: [
        { id: 'c1', fund_id: 'f1', name: 'Acme', holding_type: 'company', status: 'active' },
        { id: 'c2', fund_id: 'f1', name: 'Beta', holding_type: 'company', status: 'active' },
        { id: 'c3', fund_id: 'f1', name: 'Gamma', holding_type: 'company', status: 'active' },
      ],
      company_vehicles: [{ fund_id: 'f1', company_id: 'c1', vehicle_id: 'v1' }, { fund_id: 'f1', company_id: 'c3', vehicle_id: 'v1' }, { fund_id: 'f1', company_id: 'c2', vehicle_id: 'v2' }],
      metric_values: [{ id: 'm1', fund_id: 'f1', company_id: 'c1', period_year: 2026, period_quarter: null, period_month: 8 }],
      ask_response_overrides: [{ fund_id: 'f1', company_id: 'c3', year: 2026, quarter: 3, status: 'waived' }],
      email_requests: [{ id: 'e1', fund_id: 'f1', year: 2026, quarter: 3, status: 'sent', sent_at: '2026-10-02T09:00:00Z', due_date: '2026-10-31', recipients: ['a@x.com', 'b@x.com'] }],
    })
    const out = await OPERATIONS_HANDLERS.data_request_status(ctx(admin, fundIOnly), { year: 2026, quarter: 3 })
    expect(out).toEqual({
      year: 2026, quarter: 3, label: 'Q3 2026',
      requests: [{ sentAt: '2026-10-02T09:00:00Z', dueDate: '2026-10-31', recipients: 2 }],
      companies: [{ id: 'c1', name: 'Acme', status: 'yes' }, { id: 'c3', name: 'Gamma', status: 'waived' }],
      counts: { yes: 1, no: 0, na: 0, waived: 1 },
    })
  })

  it('wants year and quarter together', async () => {
    const { admin } = memoryAdmin({})
    await expect(OPERATIONS_HANDLERS.data_request_status(ctx(admin), { year: 2026 })).rejects.toThrow(/together/)
  })
})

describe('whats_due', () => {
  it('is for a member who sees every entity: the digest cannot be cut to some of them', async () => {
    const { admin } = memoryAdmin({})
    await expect(OPERATIONS_HANDLERS.whats_due(ctx(admin, fundIOnly), {})).rejects.toThrow(/some of them only/)
  })
})
