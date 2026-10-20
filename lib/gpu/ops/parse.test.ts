import { describe, expect, it } from 'vitest'
import { parseEarningsCsv, parseManualRows } from './parse'

const HEADER = 'asset,period_start,period_end,rented_hours,utilization_pct,gross,fee,net,downtime_hours,note'

describe('parseEarningsCsv', () => {
  it('reads the columns in order, with or without a header row', () => {
    const body = 'H200 #1,2026-09-01,2026-09-30,4320,,8640,864,7776,12,rack 4'
    const withHeader = parseEarningsCsv(`${HEADER}\n${body}`)
    const without = parseEarningsCsv(body)
    expect(withHeader.errors).toEqual([])
    expect(withHeader.rows[0]).toMatchObject({
      line: 2, assetRef: 'H200 #1', periodStart: '2026-09-01', periodEnd: '2026-09-30',
      rentedHours: 4320, utilizationPct: null, gross: 8640, fee: 864, net: 7776, downtimeHours: 12, note: 'rack 4',
    })
    expect(without.rows[0]).toMatchObject({ ...withHeader.rows[0], line: 1 })
  })

  it('defaults fee to 0, net to gross − fee and downtime to 0', () => {
    const { rows } = parseEarningsCsv('A,2026-09-01,2026-09-30,,75,1000\nB,9/1/2026,9/30/2026,,75,1000,100')
    expect(rows[0]).toMatchObject({ utilizationPct: 75, rentedHours: null, fee: 0, net: 1000, downtimeHours: 0, note: null })
    expect(rows[1]).toMatchObject({ periodStart: '2026-09-01', fee: 100, net: 900 })
  })

  it('takes a TSV paste and quoted thousands', () => {
    const { rows, errors } = parseEarningsCsv('A\t2026-09-01\t2026-09-30\t4320\t\t$8,640.00\t864\t7776')
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({ gross: 8640, net: 7776 })
    expect(parseEarningsCsv('A,2026-09-01,2026-09-30,4320,,"8,640",864,7776').rows[0].gross).toBe(8640)
  })

  it.each<[string, string, RegExp]>([
    ['neither hours nor utilization', 'A,2026-09-01,2026-09-30,,,100', /exactly one/],
    ['both hours and utilization', 'A,2026-09-01,2026-09-30,10,5,100', /exactly one/],
    ['no gross', 'A,2026-09-01,2026-09-30,10,,', /gross is required/],
    ['a net that is not gross − fee', 'A,2026-09-01,2026-09-30,10,,100,10,89.98', /not net 89.98/],
    ['a negative figure', 'A,2026-09-01,2026-09-30,10,,(100)', /cannot be negative/],
    ['a period ending before it starts', 'A,2026-09-30,2026-09-01,10,,100', /before period_start/],
    ['an unreadable date', 'A,2026-09-01,soon,10,,100', /period_end must be a date/],
    ['utilization above 100', 'A,2026-09-01,2026-09-30,,101,100', /more than 100/],
    ['no asset', ',2026-09-01,2026-09-30,10,,100', /asset is required/],
    ['a word for a number', 'A,2026-09-01,2026-09-30,ten,,100', /rented_hours "ten" is not a number/],
  ])('refuses %s, naming the row', (_, line, message) => {
    const { rows, errors } = parseEarningsCsv(`B,2026-09-01,2026-09-30,1,,1\n${line}`)
    expect(rows).toHaveLength(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/^Row 2: /)
    expect(errors[0]).toMatch(message)
  })

  it('accepts a net within the cent, not a cent off', () => {
    expect(parseEarningsCsv('A,2026-09-01,2026-09-30,10,,100.005,10,90.01').errors).toEqual([])
    expect(parseEarningsCsv('A,2026-09-01,2026-09-30,10,,100,10,90.01').errors).toHaveLength(1)
  })

  it('says so when there is nothing to import', () => {
    expect(parseEarningsCsv('')).toEqual({ rows: [], errors: ['Nothing to import'] })
    expect(parseEarningsCsv(HEADER).errors).toEqual(['Nothing to import: only a header row'])
  })
})

describe('parseManualRows', () => {
  it('takes numbers or strings, and the picker’s assetId', () => {
    const { rows, errors } = parseManualRows([
      { asset: 'H200 #1', period_start: '2026-09-01', period_end: '2026-09-30', rented_hours: 4320, gross: 8640, fee: '864' },
      { assetId: 'a-2', period_start: '2026-09-01', period_end: '2026-09-30', utilization_pct: '50', gross: '100' },
    ])
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({ line: 1, assetRef: 'H200 #1', rentedHours: 4320, fee: 864, net: 7776 })
    expect(rows[1]).toMatchObject({ line: 2, assetRef: 'a-2', utilizationPct: 50, net: 100 })
  })

  it('refuses a body that is not a list', () => {
    expect(parseManualRows('x' as any)).toEqual({ rows: [], errors: ['rows must be a list'] })
  })
})

// ── Review fixes (#90) ──
describe('review fixes', () => {
  it('refuses a fee above gross (net would be negative)', () => {
    const { rows, errors } = parseEarningsCsv('A,2026-09-01,2026-09-30,10,,100,100.01')
    expect(rows).toEqual([])
    expect(errors).toEqual(['Row 1: fee 100.01 is more than gross 100'])
  })

  it('rounds money to the cent and hours to 4 dp before anything is checked or stored', () => {
    const { rows, errors } = parseEarningsCsv('A,2026-09-01,2026-09-30,10.123456,,100.004,10.001,,0.000049')
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({ rentedHours: 10.1235, gross: 100, fee: 10, net: 90, downtimeHours: 0 })
    const half = parseEarningsCsv('A,2026-09-01,2026-09-30,,12.34565,0.125,0.005').rows[0]
    expect(Math.round(half.gross * 100)).toBe(half.gross * 100)
    expect(Math.round(half.net * 100)).toBe(Math.round(half.net * 100))
    expect(Math.round(half.gross * 100) - Math.round(half.fee * 100)).toBe(Math.round(half.net * 100))
  })

  it('treats the first record as a header only when it names the columns; a bad first data row is reported, not dropped', () => {
    const bad = parseEarningsCsv('H200 #1,soon,2026-09-30,10,,100\nH200 #2,2026-09-01,2026-09-30,10,,100')
    expect(bad.rows.map(r => r.assetRef)).toEqual(['H200 #2'])
    expect(bad.errors).toEqual(['Row 1: period_start must be a date (YYYY-MM-DD or M/D/YYYY)'])
    expect(parseEarningsCsv(' Asset , Period_Start,period_end\nA,2026-09-01,2026-09-30,1,,1').rows).toHaveLength(1)
    expect(parseEarningsCsv('server,start,end\nA,2026-09-01,2026-09-30,1,,1').errors[0]).toMatch(/^Row 1: /)
  })
})
