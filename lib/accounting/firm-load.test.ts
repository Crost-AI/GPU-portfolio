import { describe, it, expect, vi, beforeEach } from 'vitest'

const load = vi.hoisted(() => ({
  vehicles: [] as { id: string | null; name: string; kind: string }[],
  loadLedgerRowsBatch: vi.fn(async (_a: any, _f: string, ids: string[]) =>
    new Map(ids.map(id => [id, { acctRows: [], entryRows: [], postingRows: [] }]))),
  loadPostedLedger: vi.fn(async () => ({ accounts: [], postings: [], capitalPostings: [] })),
}))
vi.mock('./load', () => ({
  listVehiclesWithId: async () => load.vehicles,
  listMancoVehicles: async () => [],
  loadLedgerRowsBatch: load.loadLedgerRowsBatch,
  loadPostedLedger: load.loadPostedLedger,
}))
vi.mock('./investment-backfill', () => ({
  vehicleNames: async (_a: any, _f: string, _v: string, group: string) => [group],
  countUnderived: vi.fn(async (_a: any, _f: string, vehicleId: string) => {
    if (vehicleId === 'v3') throw new Error('db down')
    return vehicleId === 'v2' ? 4 : 0
  }),
}))
import { loadFirmOverview } from './firm-load'

const THREE = [{ id: 'v1', name: 'Fund I', kind: 'fund' }, { id: 'v2', name: 'Fund II', kind: 'fund' }, { id: 'v3', name: 'Fund III', kind: 'fund' }]

let rpc: ReturnType<typeof vi.fn>
const admin = () => ({ rpc }) as any

beforeEach(() => {
  load.vehicles = THREE
  load.loadLedgerRowsBatch.mockClear()
  load.loadPostedLedger.mockClear()
  rpc = vi.fn(async (_name: string, args: { p_vehicle_ids: string[] }) => ({
    data: args.p_vehicle_ids.map(id => ({ vehicle_id: id, posted_entries: 0, draft_entries: 0, open_bank_rows: 0, first_entry_date: null, last_entry_date: null, closed_through: null })),
    error: null,
  }))
})

describe('loadFirmOverview', () => {
  it('counts each vehicle\'s transactions that are not on the ledger; one failing count leaves that row at 0', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const o = await loadFirmOverview(admin(), 'f', { includeManco: false, includeBacklog: true })
    expect(o.vehicles.map(v => [v.name, v.underivedTransactions])).toEqual([['Fund I', 0], ['Fund II', 4], ['Fund III', 0]])
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('does not count the backlog unless asked', async () => {
    const o = await loadFirmOverview(admin(), 'f', { includeManco: false })
    expect(o.vehicles.map(v => v.underivedTransactions)).toEqual([0, 0, 0])
  })

  it('loads every ledger in one batch and every count in one call, not per vehicle', async () => {
    await loadFirmOverview(admin(), 'f', { includeManco: false })
    expect(load.loadLedgerRowsBatch).toHaveBeenCalledTimes(1)
    expect(load.loadLedgerRowsBatch.mock.calls[0][2]).toEqual(['v1', 'v2', 'v3'])
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('firm_vehicle_counts', { p_fund_id: 'f', p_vehicle_ids: ['v1', 'v2', 'v3'] })
    // Each ledger is assembled from its batched slice — no by-name reads.
    expect(load.loadPostedLedger).toHaveBeenCalledTimes(3)
    for (const call of load.loadPostedLedger.mock.calls as any[]) expect(call[5]).toEqual({ acctRows: [], entryRows: [], postingRows: [] })
  })

  it('maps each vehicle\'s counts and dates onto its row', async () => {
    rpc.mockResolvedValueOnce({
      data: [
        { vehicle_id: 'v2', posted_entries: 12, draft_entries: 3, open_bank_rows: 5, first_entry_date: '2024-01-15', last_entry_date: '2026-09-30', closed_through: '2026-06-30' },
        { vehicle_id: 'v1', posted_entries: '7', draft_entries: '0', open_bank_rows: '1', first_entry_date: '2025-03-01', last_entry_date: '2025-12-31', closed_through: null },
        { vehicle_id: 'v3', posted_entries: 0, draft_entries: 0, open_bank_rows: 0, first_entry_date: null, last_entry_date: null, closed_through: null },
      ],
      error: null,
    })
    const o = await loadFirmOverview(admin(), 'f', { includeManco: false })
    const pick = (v: any) => [v.id, v.postedEntries, v.draftEntries, v.openBankRows, v.firstEntryDate, v.lastEntryDate, v.closedThrough]
    expect(o.vehicles.map(pick)).toEqual([
      ['v1', 7, 0, 1, '2025-03-01', '2025-12-31', null],
      ['v2', 12, 3, 5, '2024-01-15', '2026-09-30', '2026-06-30'],
      ['v3', 0, 0, 0, null, null, null],
    ])
  })

  it('a failed counts read rejects rather than reporting zeros', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'permission denied' } })
    await expect(loadFirmOverview(admin(), 'f', { includeManco: false })).rejects.toThrow(/permission denied/)
  })

  it('a legacy name-only vehicle still loads its ledger by name, with zero counts', async () => {
    load.vehicles = [{ id: null, name: 'Legacy', kind: 'fund' }, THREE[0]]
    const o = await loadFirmOverview(admin(), 'f', { includeManco: false })
    expect(load.loadLedgerRowsBatch.mock.calls[0][2]).toEqual(['v1'])
    expect(load.loadPostedLedger).toHaveBeenCalledWith(expect.anything(), 'f', 'Legacy')
    expect(o.vehicles[0]).toMatchObject({ id: null, postedEntries: 0, closedThrough: null })
  })
})
