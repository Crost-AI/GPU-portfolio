import { it, expect } from 'vitest'
import { runUntilBlocked } from './assistant-runner'
import { runResearch } from './stages/research'

function fakeAdmin(rows: Record<string, any>, writes: any[]) {
  return {
    from(table: string) {
      const b: any = {}
      for (const m of ['select', 'eq', 'neq', 'not', 'in', 'order', 'limit', 'is', 'lt', 'gte', 'lte', 'ilike']) b[m] = () => b
      b.update = (v: any) => { writes.push({ table, v }); return b }
      b.insert = (v: any) => { writes.push({ table, v }); return b }
      b.maybeSingle = async () => ({ data: rows[table] ?? null, error: null })
      b.single = b.maybeSingle
      b.then = (res: any) => res({ data: Array.isArray(rows[table]) ? rows[table] : rows[table] ? [rows[table]] : [], error: null })
      return b
    },
  } as any
}

// The real research stage, on a stand-in database: the same calls come back on the second run, so
// the answers replay and the stage stores its output.
it('runs the real research stage on replayed answers', async () => {
  const writes: any[] = []
  const admin = fakeAdmin({
    diligence_memo_drafts: { id: 'd1', ingestion_output: { documents: [{ claims: [{ id: "c1", text: "ARR 1M" }] }], gap_analysis: { missing: [], present: [] }, cross_doc_flags: [] } },
    diligence_deals: { name: 'Acme' },
    fund_settings: { memo_agent_web_search_enabled: false },
  }, writes)
  const first = await runUntilBlocked({}, () => runResearch({ admin, fundId: 'f', dealId: 'x' }))
  expect(first.done).toBe(false)
  if (first.done) return
  expect(first.calls).toHaveLength(3) // claims, competitors, founders
  const answers = Object.fromEntries(first.calls.map(c => [c.id, { text: '{"findings":[{"id":"f1"}],"contradictions":[],"research_gaps":[],"competitive_map":{"named_by_company":[],"named_by_research":[]},"founder_dossiers":[]}' }]))
  const second = await runUntilBlocked(answers, () => runResearch({ admin, fundId: 'f', dealId: 'x' }))
  expect(second.done).toBe(true)
  // Stored where the worker stores it, by the stage's own code.
  expect(writes.find(w => w.table === 'diligence_memo_drafts')?.v.research_output).toMatchObject({ findings: [{ id: 'f1' }], research_mode: 'no_web_search' })
})
