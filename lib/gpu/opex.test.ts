import { describe, it, expect, beforeEach } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { createInsuranceSchedules, datacenterFeeOn, datacenterPeriods, ensureDatacenterSchedule, escalationDates, insurancePeriods } from './opex'
import { loadCloseEntrySuggestions } from '@/lib/accounting/close-suggestions'
import { PACK_INPUTS } from './fixtures/pack-v3'
import type { DatacenterContractRow } from './types'

// The pack's datacenter line: 10,280 a month, +5% a year from year 2.
const CONTRACT: DatacenterContractRow = {
  id: 'dc1', fund_id: 'f', vehicle_id: 'v-gpu', vendor_id: null, facility: 'Austin DC', start_date: '2027-01-01', end_date: null,
  monthly_fee: PACK_INPUTS.datacenterMonthly, escalator_pct: PACK_INPUTS.datacenterGrowth, escalates_on: 'anniversary',
  first_escalation_date: null, power_kw: null, includes_connectivity: true, deposit: null, schedule_id: null, allocation: 'none', status: 'active',
}
const ACCOUNTS = { expense: 'acc-5100', offset: 'acc-2000' }
const PREPAID = { expense: 'acc-5200', offset: 'acc-1500' }

describe('datacenter escalation (pure)', () => {
  it('escalates on each anniversary, compounding', () => {
    expect(escalationDates(CONTRACT, '2029-06-30')).toEqual(['2028-01-01', '2029-01-01'])
    expect(datacenterFeeOn(CONTRACT, '2027-12-31')).toBe(10_280)
    expect(datacenterFeeOn(CONTRACT, '2028-01-01')).toBe(10_794)
    expect(datacenterFeeOn(CONTRACT, '2029-03-01')).toBe(11_333.7)
  })

  it('splits the contract into one period per fee, the last left open', () => {
    expect(datacenterPeriods({ ...CONTRACT, start_date: '2027-03-15' }, '2029-01-01')).toEqual([
      { start: '2027-03-15', end: '2028-03-14', amount: 10_280 },
      { start: '2028-03-15', end: null, amount: 10_794 },
    ])
  })

  it('honours calendar_year, an explicit first date, the contract end, and no escalator', () => {
    expect(escalationDates({ ...CONTRACT, start_date: '2027-03-15', escalates_on: 'calendar_year' }, '2029-12-31')).toEqual(['2028-01-01', '2029-01-01'])
    expect(escalationDates({ ...CONTRACT, first_escalation_date: '2027-07-01' }, '2028-12-31')).toEqual(['2027-07-01', '2028-07-01'])
    expect(escalationDates({ ...CONTRACT, end_date: '2028-06-30' }, '2030-12-31')).toEqual(['2028-01-01'])
    expect(escalationDates({ ...CONTRACT, escalator_pct: 0 }, '2030-12-31')).toEqual([])
  })
})

describe('insurance prepaid (pure)', () => {
  it('one schedule when the premium divides, a final-month schedule for the remainder when not', () => {
    expect(insurancePeriods(12_000, '2027-01-01', 12)).toEqual([{ start: '2027-01-01', end: '2027-12-31', amount: 1_000 }])
    expect(insurancePeriods(10_000, '2027-01-01', 12)).toEqual([
      { start: '2027-01-01', end: '2027-11-30', amount: 833.33 },
      { start: '2027-12-01', end: '2027-12-31', amount: 833.37 },
    ])
  })
})

describe('schedules the close proposes', () => {
  let m: ReturnType<typeof memoryAdmin>
  beforeEach(() => {
    m = memoryAdmin({
      fund_vehicles: [{ id: 'v-gpu', fund_id: 'f', name: 'H200 SPV I', kind: 'gpu_spv', aliases: [] }],
      datacenter_contracts: [{ ...CONTRACT }], accounting_schedules: [], accounting_schedule_lines: [], journal_entries: [],
    })
  })
  const target = { fundId: 'f', vehicleId: 'v-gpu', userId: 'u', accounts: ACCOUNTS }
  const contract = () => m.tables.datacenter_contracts[0] as DatacenterContractRow
  const proposals = (start: string, end: string) => loadCloseEntrySuggestions(m.admin, 'f', 'H200 SPV I', start, end)

  it('creates the accrual, is idempotent, and rolls over ON the escalation date', async () => {
    const first = await ensureDatacenterSchedule(m.admin, contract(), target, '2027-06-30')
    expect(first.created).toBe(1)
    expect(contract().schedule_id).toBe(first.scheduleId)
    expect((await ensureDatacenterSchedule(m.admin, contract(), target, '2027-12-31')).created).toBe(0)
    expect(m.tables.accounting_schedules).toHaveLength(1)

    const next = await ensureDatacenterSchedule(m.admin, contract(), target, '2028-01-01')
    expect(next.created).toBe(1)
    const [old, current] = m.tables.accounting_schedules
    expect([old.start_date, old.end_date]).toEqual(['2027-01-01', '2027-12-31'])
    expect([current.start_date, current.end_date, current.required_for_close]).toEqual(['2028-01-01', null, true])
    expect(contract().schedule_id).toBe(next.scheduleId)

    const dec = await proposals('2027-12-01', '2027-12-31')
    const jan = await proposals('2028-01-01', '2028-01-31')
    expect(dec.map(s => s.postings.map(p => [p.accountId, p.amount]))).toEqual([[['acc-5100', 10_280], ['acc-2000', -10_280]]])
    expect(jan.map(s => s.postings.map(p => [p.accountId, p.amount]))).toEqual([[['acc-5100', 10_794], ['acc-2000', -10_794]]])
    expect(jan[0]).toMatchObject({ entryDate: '2028-01-31', sourceType: 'partnership_expense', required: true })
  })

  const rows = () => m.tables.accounting_schedules.map((r: any) => [
    r.start_date, r.end_date, m.tables.accounting_schedule_lines.find((l: any) => l.schedule_id === r.id && l.sort_order === 0)!.amount,
  ])

  it('a rollover across two escalations creates every intermediate year, each ending before the next', async () => {
    await ensureDatacenterSchedule(m.admin, contract(), target, '2027-06-30')
    const rolled = await ensureDatacenterSchedule(m.admin, contract(), target, '2029-01-01')
    expect(rolled.created).toBe(2)
    expect(rows()).toEqual([
      ['2027-01-01', '2027-12-31', 10_280],
      ['2028-01-01', '2028-12-31', 10_794],
      ['2029-01-01', null, 11_333.7],
    ])
    expect(contract().schedule_id).toBe(rolled.scheduleId)
    expect((await proposals('2028-06-01', '2028-06-30')).map(x => x.postings[0].amount)).toEqual([10_794])
    expect((await ensureDatacenterSchedule(m.admin, contract(), target, '2029-01-01')).created).toBe(0)
  })

  it('a contract first set up after an escalation gets its whole history once', async () => {
    expect((await ensureDatacenterSchedule(m.admin, contract(), target, '2028-03-01')).created).toBe(2)
    expect(rows()).toEqual([['2027-01-01', '2027-12-31', 10_280], ['2028-01-01', null, 10_794]])
    expect((await ensureDatacenterSchedule(m.admin, contract(), target, '2028-12-31')).created).toBe(0)
  })

  it('a double submit or a second first call creates no duplicate schedule', async () => {
    const insurance = { name: 'Fleet insurance 2027', premium: 10_000, startDate: '2027-01-01', months: 12 }
    const first = await createInsuranceSchedules(m.admin, { ...target, accounts: PREPAID }, insurance)
    expect(await createInsuranceSchedules(m.admin, { ...target, accounts: PREPAID }, insurance)).toEqual(first)
    // Two first calls that both read the contract before either linked a schedule.
    const unlinked = { ...contract() }
    await ensureDatacenterSchedule(m.admin, unlinked, target, '2027-06-30')
    await ensureDatacenterSchedule(m.admin, unlinked, target, '2027-06-30')
    expect(m.tables.accounting_schedules).toHaveLength(3)
  })

  it('a failed lines insert leaves no header behind', async () => {
    m.failNext('accounting_schedule_lines', 'insert', 'network error')
    await expect(ensureDatacenterSchedule(m.admin, contract(), target, '2027-06-30')).rejects.toBeTruthy()
    expect(m.tables.accounting_schedules).toEqual([])
  })

  it('refuses a target that is not the contract’s vehicle', async () => {
    await expect(ensureDatacenterSchedule(m.admin, contract(), { ...target, vehicleId: 'v-other' }, '2027-06-30')).rejects.toThrow('another entity')
    expect(m.tables.accounting_schedules).toEqual([])
  })

  it('amortizes an insurance premium through accounting_schedules: Dr 5200 / Cr 1500 monthly', async () => {
    await createInsuranceSchedules(m.admin, { ...target, accounts: PREPAID }, { name: 'Fleet insurance 2027', premium: 10_000, startDate: '2027-01-01', months: 12 })
    const mar = await proposals('2027-03-01', '2027-03-31')
    const dec = await proposals('2027-12-01', '2027-12-31')
    expect(mar.map(s => s.postings.map(p => [p.accountId, p.amount]))).toEqual([[['acc-5200', 833.33], ['acc-1500', -833.33]]])
    expect(dec.map(s => s.postings.map(p => [p.accountId, p.amount]))).toEqual([[['acc-5200', 833.37], ['acc-1500', -833.37]]])
    expect(await proposals('2028-01-01', '2028-01-31')).toEqual([])
  })
})
