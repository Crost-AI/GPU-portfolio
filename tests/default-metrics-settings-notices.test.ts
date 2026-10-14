// The Settings notices after an apply: a failed batch must never read as "already up to date".
import { describe, expect, it } from 'vitest'
import { syncNotice, addNotice } from '@/components/settings/default-metrics-settings'

const failed = ['Inserting 500 metrics for 250 companies (co-1 +249 more) failed']

describe('syncNotice', () => {
  it('reports a sync where nothing landed as a failure, with retry guidance', () => {
    const msg = syncNotice({ inserted: 0, companies: 250, errors: failed })
    expect(msg).toMatch(/failed/i)
    expect(msg).toMatch(/try sync again/i)
    expect(msg).not.toMatch(/up to date/)
  })
  it('reports a partial sync as partial', () => {
    const msg = syncNotice({ inserted: 100, companies: 250, errors: failed })
    expect(msg).toMatch(/Added 100 metrics/)
    expect(msg).toMatch(/could not be updated/)
  })
  it('keeps the success wording when nothing failed', () => {
    expect(syncNotice({ inserted: 0, companies: 3, errors: [] })).toBe('All 3 companies are already up to date.')
    expect(syncNotice({ inserted: 1, companies: 3 })).toBe('Added 1 metric across 3 companies.')
  })
})

describe('addNotice', () => {
  it('says the template was saved but not applied when nothing landed', () => {
    const msg = addNotice({ inserted: 0, companies: 250, errors: failed })
    expect(msg).toMatch(/Added to the profile/)
    expect(msg).toMatch(/could not be applied/)
    expect(msg).not.toMatch(/already tracked/)
  })
  it('reports a partial apply as partial, counting metrics rather than companies', () => {
    // 3 templates into 2 companies is 6 rows: never "6 of 2 companies"
    const msg = addNotice({ inserted: 6, companies: 2, errors: failed })
    expect(msg).toMatch(/Added to the profile and 6 metrics/)
    expect(msg).toMatch(/some companies could not be updated/)
    expect(msg).not.toMatch(/of 2 companies/)
  })
  it('keeps the success wording when nothing failed', () => {
    expect(addNotice({ inserted: 0, companies: 3, errors: [] })).toBe('Added to the profile. All 3 companies already tracked it.')
    expect(addNotice({ inserted: 6, companies: 3 })).toBe('Added to the profile; 6 metrics added across 3 companies.')
  })
})
