import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CurrencyProvider } from '@/components/currency-context'
import { DraftForm, foreignCurrency, parseReportingAmount } from '@/app/(app)/funds/receipts/view'

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
  it('asks for the total in the books\' currency and holds the Draft button until it has one', () => {
    const html = form('EUR')
    expect(html).toContain('Total in USD')
    expect(html).toMatch(/<input[^>]*required=""[^>]*placeholder="EUR 100.00"/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Draft entry<\/button>/)
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

  it('accepts a typed total only once it is at least a cent', () => {
    expect(parseReportingAmount('108.50')).toBe(108.5)
    expect(parseReportingAmount('1,250.00')).toBe(1250)
    for (const bad of ['', '0', '0.004', '-5', 'abc', '1e3', '12.3.4']) expect(parseReportingAmount(bad), bad).toBeNull()
  })
})
