import { describe, expect, it } from 'vitest'
import { runQuery, type Column } from '@/lib/agent/query/engine'

const columns: Column[] = [
  { name: 'lp', type: 'string' }, { name: 'vehicle', type: 'string' }, { name: 'commitment', type: 'number' },
  { name: 'paid_in', type: 'number' }, { name: 'date', type: 'date' }, { name: 'tags', type: 'list' }, { name: 'active', type: 'boolean' },
]
const rows = [
  { lp: 'Acme', vehicle: 'Fund I', commitment: 1000, paid_in: 400, date: '2025-02-10', tags: ['Family Office'], active: true },
  { lp: 'Birch', vehicle: 'Fund I', commitment: 500, paid_in: 450, date: '2025-05-01', tags: ['Endowment'], active: true },
  { lp: 'Cedar', vehicle: 'Fund II', commitment: 2000, paid_in: 0, date: '2026-01-15', tags: [], active: false },
  { lp: 'Dune', vehicle: 'Fund II', commitment: null, paid_in: 100, date: null, tags: ['family office', 'Fund of funds'], active: true },
]

describe('the query engine', () => {
  it('filters with every op, case-insensitively for text', () => {
    const lps = (where: any[]) => runQuery(rows, columns, { where }).rows.map(r => r.lp)
    expect(lps([{ column: 'vehicle', op: 'eq', value: 'fund i' }])).toEqual(['Acme', 'Birch'])
    expect(lps([{ column: 'commitment', op: 'gte', value: 1000 }])).toEqual(['Acme', 'Cedar'])
    expect(lps([{ column: 'date', op: 'between', value: ['2025-01-01', '2025-12-31'] }])).toEqual(['Acme', 'Birch'])
    expect(lps([{ column: 'lp', op: 'in', value: ['acme', 'Dune'] }])).toEqual(['Acme', 'Dune'])
    expect(lps([{ column: 'commitment', op: 'is_null' }])).toEqual(['Dune'])
    expect(lps([{ column: 'tags', op: 'contains', value: 'family' }])).toEqual(['Acme', 'Dune'])
    expect(lps([{ column: 'tags', op: 'is_null' }])).toEqual(['Cedar'])
    expect(lps([{ column: 'active', op: 'eq', value: false }])).toEqual(['Cedar'])
  })

  it('groups, buckets dates, aggregates and sorts', () => {
    const out = runQuery(rows, columns, {
      group_by: ['vehicle'],
      aggregates: [{ fn: 'sum', column: 'commitment' }, { fn: 'count' }, { fn: 'avg', column: 'paid_in', as: 'avg_paid' }],
      order_by: [{ column: 'sum_commitment', direction: 'desc' }],
    })
    expect(out.rows).toEqual([
      { vehicle: 'Fund II', sum_commitment: 2000, count: 2, avg_paid: 50 },
      { vehicle: 'Fund I', sum_commitment: 1500, count: 2, avg_paid: 425 },
    ])
    const byQuarter = runQuery(rows, columns, { group_by: ['date:quarter'], where: [{ column: 'date', op: 'not_null' }], order_by: [{ column: 'date_quarter' }] })
    expect(byQuarter.rows.map(r => r.date_quarter)).toEqual(['2025-Q1', '2025-Q2', '2026-Q1'])
    expect(runQuery(rows, columns, { aggregates: [{ fn: 'median', column: 'paid_in' }] }).rows).toEqual([{ median_paid_in: 250 }])
  })

  it('selects columns, limits, and says when it trimmed', () => {
    const out = runQuery(rows, columns, { columns: ['lp'], order_by: [{ column: 'lp', direction: 'desc' }], limit: 2 })
    expect(out).toEqual({ columns: ['lp'], rows: [{ lp: 'Dune' }, { lp: 'Cedar' }], matched: 4, truncated: true })
  })

  it('refuses what it cannot do, naming the columns', () => {
    expect(() => runQuery(rows, columns, { where: [{ column: 'nope', op: 'eq', value: 1 }] })).toThrow(/unknown column "nope".*Columns: lp/)
    expect(() => runQuery(rows, columns, { aggregates: [{ fn: 'sum', column: 'lp' }] })).toThrow('needs a number column')
    expect(() => runQuery(rows, columns, { group_by: ['lp:month'] })).toThrow('only a date column')
    expect(() => runQuery(rows, columns, { where: [{ column: 'lp', op: 'like' as any, value: 'x' }] })).toThrow('Unknown filter op')
  })
})
