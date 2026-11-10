import { describe, it, expect } from 'vitest'
import { entriesTouching, expenseRange } from './partnership-invoices'
import { quarterBounds } from './receipts-core'

describe('expenseRange', () => {
  const q3 = quarterBounds(2026, 3)
  it('reads every earlier unbilled expense through the quarter’s end by default', () => {
    expect(expenseRange(q3)).toEqual({ from: null, through: '2026-09-30' })
  })
  it('takes the dates the person chose', () => {
    expect(expenseRange(q3, '2026-06-25', '2026-09-30')).toEqual({ from: '2026-06-25', through: '2026-09-30' })
  })
  it('refuses a start after the end, and a date that is not one', () => {
    expect(expenseRange(q3, '2026-10-01', '2026-09-30')).toHaveProperty('error')
    expect(expenseRange(q3, '2026-02-30')).toHaveProperty('error')
  })
})

describe('entriesTouching', () => {
  const stub = (total: number, error: { message: string } | null = null) => {
    let range: [number, number] = [0, 0]
    const q: any = {
      select: () => q, eq: () => q, in: () => q, gte: () => q, lte: () => q, order: () => q,
      range: (from: number, to: number) => { range = [from, to]; return q },
      then: (done: (r: unknown) => unknown) => done({
        error,
        data: error ? null : Array.from({ length: Math.max(0, Math.min(total - range[0], 1000)) }, (_, i) => ({ id: `e${range[0] + i}`, journal_postings: [{ id: 'p', amount: '1', account_id: 'a' }] })),
      }),
    }
    return { from: () => q } as any
  }

  it('reads past PostgREST\'s 1000-row cap, so earlier expenses are not lost (Bugbot on #133)', async () => {
    const rows = await entriesTouching(stub(1200), 'f', 'v', ['a'], { window: { start: null, end: '2026-09-30' }, statuses: ['posted'] })
    expect(rows).toHaveLength(1200)
    expect(rows[1199].journal_postings[0].amount).toBe(1)
  })

  it('says what could not be read', async () => {
    await expect(entriesTouching(stub(0, { message: 'boom' }), 'f', 'v', ['a'], { statuses: ['posted'] })).rejects.toThrow('The Due-from entries could not be read: boom')
  })
})
