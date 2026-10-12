import { describe, expect, it } from 'vitest'
import { OVERLAP_DAYS, rebatch, resolveWindow, runSync } from './sync.js'
import type { Connector, JournalTransaction, StateStore } from './types.js'

class MemoryState implements StateStore {
  data: Record<string, unknown> = {}
  async get<T>(k: string) { return this.data[k] as T | undefined }
  async set<T>(k: string, v: T) { this.data[k] = v }
}

const txn = (i: number): JournalTransaction => ({ date: '2026-01-15', num: `JE-${i}`, lines: [{ account: 'Cash', debit: 1 }, { account: 'Capital', credit: 1 }] })

const connector = (pages: JournalTransaction[][]): Connector => ({
  id: 'test', source: 'quickbooks', description: '',
  async *pull() { for (const p of pages) yield p },
})

describe('resolveWindow', () => {
  it('re-reads an overlap before the last cursor', async () => {
    const state = new MemoryState()
    await state.set('cursor', '2026-03-31')
    const w = await resolveWindow(state, {}, '2026-04-30')
    expect(w).toEqual({ from: '2026-02-14', to: '2026-04-30' })
    expect(OVERLAP_DAYS).toBe(45)
  })

  it('starts a year back on a first run, and explicit dates win', async () => {
    expect(await resolveWindow(new MemoryState(), {}, '2026-04-30')).toEqual({ from: '2025-04-30', to: '2026-04-30' })
    expect(await resolveWindow(new MemoryState(), { from: '2020-01-01', to: '2020-12-31' })).toEqual({ from: '2020-01-01', to: '2020-12-31' })
  })
})

describe('rebatch', () => {
  it('reshapes source pages into fixed-size batches without losing any', async () => {
    const out: number[] = []
    for await (const b of await rebatch((async function* () { yield [txn(1), txn(2), txn(3)]; yield [txn(4)] })(), 2)) out.push(b.length)
    expect(out).toEqual([2, 2])
  })
})

describe('runSync', () => {
  it('tallies batches and advances the cursor after a complete run', async () => {
    const state = new MemoryState()
    const sent: number[] = []
    const portfolio = { importJournal: async (_s: string, b: JournalTransaction[]) => { sent.push(b.length); return { created: b.length, alreadyPresent: 0, skipped: 0 } } }
    const s = await runSync(connector([[txn(1), txn(2)]]), portfolio as any, state, { window: { from: '2026-01-01', to: '2026-01-31' } })
    expect(s.created).toBe(2)
    expect(sent).toEqual([2])
    expect(state.data.cursor).toBe('2026-01-31')
  })

  it('stops on a review hold and leaves the cursor where it was', async () => {
    const state = new MemoryState()
    await state.set('cursor', '2025-12-31')
    const portfolio = { importJournal: async () => ({ reviewRequired: true, error: 'Review', importReview: { token: 't1', differences: [{ message: 'Cost differs' }] } }) }
    const s = await runSync(connector([[txn(1)], [txn(2)]]), portfolio as any, state, { window: { from: '2026-01-01', to: '2026-01-31' } })
    expect(s.reviewRequired).toEqual({ token: 't1', differences: ['Cost differs'] })
    expect(s.batches).toBe(1)
    expect(state.data.cursor).toBe('2025-12-31')
  })

  it('never advances the cursor on a dry run', async () => {
    const state = new MemoryState()
    const portfolio = { importJournal: async () => ({ wouldCreate: 1 }) }
    const s = await runSync(connector([[txn(1)]]), portfolio as any, state, { window: { from: '2026-01-01', to: '2026-01-31' }, dryRun: true })
    expect(s.created).toBe(1)
    expect(state.data.cursor).toBeUndefined()
  })
})
