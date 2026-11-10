import { describe, expect, it } from 'vitest'
import { ACCOUNTING_SECTIONS, sectionsForKind, hasSectionForKind } from '@/lib/accounting/nav'

const labels = (kind: string | null, pending = {}) => sectionsForKind(ACCOUNTING_SECTIONS, kind, pending).map(s => s.label)

// Receipts are kept on the management company's books; anywhere else the page only matters while
// a receipt is waiting. Partnership expenses are billed by the entities that pay them.
describe('sections listed for some kinds only', () => {
  it('lists Receipts and Partnership expenses for a management company', () => {
    expect(labels('manco')).toEqual(expect.arrayContaining(['Receipts', 'Partnership expenses']))
  })

  it('leaves Receipts out of a fund with nothing waiting, and lists it once one is', () => {
    expect(labels('fund')).not.toContain('Receipts')
    expect(labels('fund', { receipts: 0 })).not.toContain('Receipts')
    expect(labels('fund', { receipts: 2 })).toContain('Receipts')
  })

  it('never lists Partnership expenses on a fund', () => {
    expect(labels('fund', { receipts: 2 })).not.toContain('Partnership expenses')
    expect(labels('associate')).toContain('Partnership expenses')
  })

  it('lists both firm-wide, where the landing asks which entity', () => {
    expect(labels(null)).toEqual(expect.arrayContaining(['Receipts', 'Partnership expenses']))
  })

  it('keeps a fund’s Receipts page reachable from the firm-wide landing', () => {
    expect(hasSectionForKind('receipts', 'fund')).toBe(true)
    expect(hasSectionForKind('partnership-expenses', 'fund')).toBe(false)
  })
})
