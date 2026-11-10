import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

// mergeCompanies (upstream #148) deletes the merged record last, and that delete cascades whatever is
// still on it and removes stored documents. A move that fails must keep the record, so the rows it
// still holds survive (Codex on #125).

const s = vi.hoisted(() => ({ m: null as any, deleteCompany: vi.fn() }))
vi.mock('@/lib/activity', () => ({ logActivity: () => {} }))
vi.mock('@/lib/companies/delete', () => ({ deleteCompany: s.deleteCompany }))
vi.mock('@/lib/portfolio/fund-holding-delete', () => ({ deleteFundHolding: s.deleteCompany }))
import { mergeCompanies } from '@/lib/companies/merge'

beforeEach(() => {
  s.m = memoryAdmin({
    companies: [
      { id: 'dup', fund_id: 'f', name: 'Acme Inc', aliases: [], holding_type: 'company', portfolio_group: ['Fund I'] },
      { id: 'acme', fund_id: 'f', name: 'Acme', aliases: [], holding_type: 'company', portfolio_group: ['Fund I'] },
    ],
    company_documents: [{ id: 'doc-1', fund_id: 'f', company_id: 'dup', file_name: 'board-deck.pdf' }],
    company_notes: [{ id: 'note-1', fund_id: 'f', company_id: 'dup', body: 'Call notes' }],
    metrics: [
      { id: 'm-arr', fund_id: 'f', company_id: 'dup', slug: 'arr' },
      { id: 'm-cash-dup', fund_id: 'f', company_id: 'dup', slug: 'cash' },
      { id: 'm-cash', fund_id: 'f', company_id: 'acme', slug: 'cash' },
    ],
    metric_values: [
      { id: 'v-arr', fund_id: 'f', company_id: 'dup', metric_id: 'm-arr', value: 100 },
      { id: 'v-cash-dup', fund_id: 'f', company_id: 'dup', metric_id: 'm-cash-dup', value: 50 },
      { id: 'v-cash', fund_id: 'f', company_id: 'acme', metric_id: 'm-cash', value: 75 },
    ],
  })
  // The real delete cascades the record's rows: the spy does the same, so a call would lose them.
  s.deleteCompany.mockReset().mockImplementation(async (_admin: any, _who: any, id: string) => {
    for (const t of ['companies', 'company_documents', 'company_notes', 'metrics', 'metric_values']) {
      s.m.tables[t] = s.m.tables[t].filter((r: any) => (t === 'companies' ? r.id : r.company_id) !== id)
    }
    return { ok: true, value: { id, name: 'Acme Inc' } }
  })
})

const merge = () => mergeCompanies(s.m.admin, { fundId: 'f', userId: 'u', vehicleNames: null }, 'dup', 'acme',
  async () => ({ access: { fundId: 'f', vehicles: { all: true, ids: [] } } as any, vehicleNames: null }))

describe('merging two records when a move fails', () => {
  it('keeps the merged record and the documents it still holds', async () => {
    s.m.failNext('company_documents', 'update', 'statement timeout')
    const out = await merge()
    expect(out).toMatchObject({ ok: true, value: { deleted: false } })
    expect((out as any).value.keptBecause).toMatch(/company_documents \(statement timeout\)/)
    expect(s.deleteCompany).not.toHaveBeenCalled()
    expect(s.m.tables.companies.map((c: any) => c.id).sort()).toEqual(['acme', 'dup'])
    expect(s.m.tables.company_documents).toEqual([expect.objectContaining({ id: 'doc-1', company_id: 'dup' })])
    // What did move, moved: the note is on the kept record.
    expect(s.m.tables.company_notes).toEqual([expect.objectContaining({ id: 'note-1', company_id: 'acme' })])
  })

  it('keeps it when the kept record\'s names cannot be saved', async () => {
    s.m.failNext('companies', 'update', 'connection reset')
    const out = await merge()
    expect(out).toMatchObject({ ok: true, value: { deleted: false } })
    expect(s.deleteCompany).not.toHaveBeenCalled()
  })

  it('a failed metric-values move is finished by the retry, so the values survive the delete', async () => {
    s.m.failNext('metric_values', 'update', 'statement timeout')
    const first = await merge()
    expect(first).toMatchObject({ ok: true, value: { deleted: false } })
    expect((first as any).value.keptBecause).toMatch(/metric values \(statement timeout\)/)
    expect(s.deleteCompany).not.toHaveBeenCalled()
    // The definition moved and its value did not: the state the retry has to finish from.
    const value = (id: string) => s.m.tables.metric_values.find((v: any) => v.id === id)
    expect(s.m.tables.metrics.find((m: any) => m.id === 'm-arr').company_id).toBe('acme')
    expect(value('v-arr').company_id).toBe('dup')

    const second = await merge()
    expect(second).toMatchObject({ ok: true, value: { deleted: true, rowsMoved: { metric_values: 1 } } })
    expect(value('v-arr').company_id).toBe('acme')
    // A metric the kept record already tracks stays behind, and its values go with the merged record.
    expect(value('v-cash-dup')).toBeUndefined()
    expect(value('v-cash').company_id).toBe('acme')
  })

  it('deletes the merged record once everything has moved', async () => {
    const out = await merge()
    expect(out).toMatchObject({ ok: true, value: { deleted: true } })
    expect(s.deleteCompany).toHaveBeenCalledTimes(1)
    expect(s.m.tables.company_documents).toEqual([expect.objectContaining({ id: 'doc-1', company_id: 'acme' })])
  })
})
