import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CurrencyProvider } from '@/components/currency-context'
import {
  DraftForm, DRAFT_CONNECTION_ERROR, canDraft, draftBody, foreignCurrency, parseReportingAmount, runDraft,
} from '@/app/(app)/funds/receipts/view'

const receipt = (currency: string | null) => ({
  id: 'r1', vehicle_id: 'v1', source: 'upload', file_name: 'dinner.pdf', vendor_name: 'Hotel Adlon',
  receipt_date: '2026-03-10', amount: 100, currency, description: null, extraction_status: 'complete',
  extraction_notes: null, status: 'unmatched', journal_entry_id: null, bank_transaction_id: null,
}) as any

const form = (currency: string | null, books = 'USD') => renderToStaticMarkup(
  <CurrencyProvider currency={books}>
    <DraftForm r={receipt(currency)} onDraft={async () => null} onCancel={() => {}} />
  </CurrencyProvider>,
)

describe('drafting a receipt in another currency', () => {
  it('asks for the total in the books\' currency', () => {
    const html = form('EUR')
    expect(html).toContain('Total in USD')
    expect(html).toMatch(/<input[^>]*required=""[^>]*placeholder="EUR 100.00"/)
  })

  // The static render has no accounts chosen, so the button's state there proves nothing; the rule
  // and the payload are the helpers the button uses.
  const chosen = { debit: 'travel', credit: 'card', billTo: '' }

  it('holds the Draft button for a foreign receipt until the books-currency total is entered', () => {
    expect(canDraft({ ...chosen, foreign: 'EUR', reportingAmount: null })).toBe(false)
    expect(canDraft({ ...chosen, foreign: 'EUR', reportingAmount: 108.5 })).toBe(true)
    expect(canDraft({ ...chosen, foreign: null, reportingAmount: null })).toBe(true)
    expect(canDraft({ ...chosen, credit: '', foreign: null, reportingAmount: null })).toBe(false)
  })

  it('sends the books-currency total as a number only for a foreign receipt', () => {
    expect(draftBody({ ...chosen, foreign: 'EUR', reportingAmount: 108.5 })).toEqual({ debitAccountId: 'travel', creditAccountId: 'card', reportingAmount: 108.5 })
    expect(draftBody({ ...chosen, foreign: null, reportingAmount: null })).toEqual({ debitAccountId: 'travel', creditAccountId: 'card' })
    expect(draftBody({ ...chosen, billTo: 'fund-2', foreign: 'EUR', reportingAmount: 1250 })).toEqual({ creditAccountId: 'card', billToVehicleId: 'fund-2', reportingAmount: 1250 })
  })

  it('turns a dropped connection into a message instead of a stuck form', async () => {
    expect(await runDraft(() => Promise.reject(new TypeError('Failed to fetch')), {})).toBe(DRAFT_CONNECTION_ERROR)
    expect(await runDraft(async () => 'This receipt is in EUR', {})).toBe('This receipt is in EUR')
    expect(await runDraft(async () => null, {})).toBeNull()
  })

  it('asks for nothing extra when the receipt is in the books\' currency or has none', () => {
    expect(form('usd')).not.toContain('Total in')
    expect(form(null)).not.toContain('Total in')
    expect(form('EUR', 'EUR')).not.toContain('Total in')
  })

  it('names the receipt currency only when it differs from the books', () => {
    expect(foreignCurrency('eur', 'USD')).toBe('EUR')
    expect(foreignCurrency('USD', 'usd')).toBeNull()
    expect(foreignCurrency(null, 'USD')).toBeNull()
  })

  it('accepts a typed total only once it is a plain amount of at least a cent', () => {
    expect(parseReportingAmount('108.50')).toBe(108.5)
    expect(parseReportingAmount('1,250.00')).toBe(1250)
    expect(parseReportingAmount('12,345,678.9')).toBe(12345678.9)
    expect(parseReportingAmount(' 108 ')).toBe(108)
    // A decimal comma is refused, not read as 10850 or 1.2345; nor a third decimal or bad grouping.
    for (const bad of ['108,50', '1.234,50', '108.505', '12,34', '1,2345', ',100', '', '0', '0.004', '-5', 'abc', '1e3', '12.3.4']) {
      expect(parseReportingAmount(bad), bad).toBeNull()
    }
  })
})
