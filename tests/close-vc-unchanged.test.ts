import { describe, it, expect } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { DEFAULT_CHART } from '@/lib/accounting/chart'
import { loadCloseEntrySuggestions } from '@/lib/accounting/close-suggestions'
import { checkReadiness, closePeriodWithAllocation } from '@/lib/accounting/close'

/**
 * ── GPU fleet (P1) ── A VC fund's close is unchanged by the fleet (P1b-2b). The expected values are
 * a SNAPSHOT captured by running this exact file against origin/main @ 02cfe60c, before the fleet
 * touched close-suggestions.ts or close.ts: the suggestions, the readiness and the review checks a
 * close persists must deep-equal what main produced.
 */

const fixture = () => memoryAdmin({
  funds: [{ id: 'f', name: 'Fund' }],
  fund_settings: [{ fund_id: 'f', currency: 'USD' }],
  fund_vehicles: [{ id: 'v1', fund_id: 'f', name: 'Fund I', kind: 'fund', aliases: [], active: true }],
  chart_of_accounts: [
    ...DEFAULT_CHART.map(a => ({ id: `a-${a.code}`, fund_id: 'f', vehicle_id: 'v1', portfolio_group: 'Fund I', code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null, lp_entity_id: null })),
    ...['lpa', 'lpb'].map(lp => ({ id: `a-3100-${lp}`, fund_id: 'f', vehicle_id: 'v1', portfolio_group: 'Fund I', code: `3100-${lp}`, name: `Capital ${lp}`, type: 'equity', subtype: 'lp_capital', lp_entity_id: lp })),
  ],
  lp_investments: [
    { id: 'i1', fund_id: 'f', portfolio_group: 'Fund I', entity_id: 'lpa', commitment: 600_000 },
    { id: 'i2', fund_id: 'f', portfolio_group: 'Fund I', entity_id: 'lpb', commitment: 400_000 },
  ],
  accounting_schedules: [{ id: 's1', fund_id: 'f', vehicle_id: 'v1', name: 'Audit fee accrual', memo: 'Audit fee', source_type: 'partnership_expense', start_date: '2027-01-01', end_date: null, day_of_month: 31, required_for_close: true, active: true }],
  accounting_schedule_lines: [
    { id: 'l1', schedule_id: 's1', account_id: 'a-5200', amount: 1000, sort_order: 0 },
    { id: 'l2', schedule_id: 's1', account_id: 'a-1000', amount: -1000, sort_order: 1 },
  ],
  journal_entries: [
    { id: 'e1', fund_id: 'f', vehicle_id: 'v1', portfolio_group: 'Fund I', book: 'actual', status: 'posted', entry_date: '2027-01-15', memo: 'Bank fee — 2027-01', source_type: 'partnership_expense', source_ref: null },
    { id: 'e2', fund_id: 'f', vehicle_id: 'v1', portfolio_group: 'Fund I', book: 'actual', status: 'posted', entry_date: '2027-02-15', memo: 'Bank fee — 2027-02', source_type: 'partnership_expense', source_ref: null },
    { id: 'e3', fund_id: 'f', vehicle_id: 'v1', portfolio_group: 'Fund I', book: 'actual', status: 'draft', entry_date: '2027-03-10', memo: 'Draft', source_type: 'manual', source_ref: null },
  ],
  journal_postings: [
    ...['e1', 'e2', 'e3'].flatMap(id => [
      { id: `${id}-a`, journal_entry_id: id, fund_id: 'f', vehicle_id: 'v1', book: 'actual', account_id: 'a-5200', amount: 25, currency: 'USD', lp_entity_id: null },
      { id: `${id}-b`, journal_entry_id: id, fund_id: 'f', vehicle_id: 'v1', book: 'actual', account_id: 'a-1000', amount: -25, currency: 'USD', lp_entity_id: null },
    ]),
  ],
  bank_transactions: [{ id: 'b1', fund_id: 'f', vehicle_id: 'v1', txn_date: '2027-03-12', amount: -25, status: 'unmatched' }],
  fiscal_periods: [], close_reviews: [], close_review_checks: [], lp_entities: [], fund_member_vehicles: [],
})

describe('a VC fund close is unchanged (snapshot from main)', () => {
  it('suggestions', async () => {
    const m = fixture()
    expect(await loadCloseEntrySuggestions(m.admin, 'f', 'Fund I', '2027-03-01', '2027-03-31')).toMatchInlineSnapshot(`
      [
        {
          "basis": "schedule",
          "detail": "Expected from the monthly accounting schedule on 2027-03-31.",
          "entryDate": "2027-03-31",
          "evidence": {
            "scheduleId": "s1",
          },
          "id": "schedule:s1:2027-03-31",
          "memo": "Audit fee",
          "postings": [
            {
              "accountId": "a-5200",
              "amount": 1000,
              "currency": "USD",
              "lpEntityId": undefined,
            },
            {
              "accountId": "a-1000",
              "amount": -1000,
              "currency": "USD",
              "lpEntityId": undefined,
            },
          ],
          "required": true,
          "sourceRef": "schedule:s1:2027-03-31",
          "sourceType": "partnership_expense",
          "title": "Audit fee accrual",
        },
      ]
    `)
  })

  it('readiness', async () => {
    const m = fixture()
    expect(await checkReadiness(m.admin as any, 'f', 'Fund I', '2027-03-01', '2027-03-31')).toMatchInlineSnapshot(`
      {
        "bank": {
          "bankEndingBalance": -25,
          "difference": -25,
          "ledgerCashBalance": -50,
          "tiesOut": false,
          "unmatchedCount": 1,
        },
        "blockerLinks": {},
        "blockers": [
          "1 journal entry is still in draft inside this span (from 2027-03-10). A draft has no P&L in the ledger, so closing would allocate nothing for it — and lock the period so it can't be posted. Post or void them first.",
          "1 bank transaction in this span is not posted yet (net -25.00). Categorize and post them on the Bank page — otherwise their income and expense is never allocated to any partner.",
        ],
        "draftEntries": {
          "count": 1,
          "earliest": "2027-03-10",
          "items": [
            {
              "amount": 25,
              "entryDate": "2027-03-10",
              "id": "e3",
              "memo": "Draft",
            },
          ],
        },
        "unpostedBankTxns": {
          "count": 1,
          "total": -25,
        },
        "warnings": [],
      }
    `)
  })

  it('the review checks a close persists', async () => {
    const m = fixture()
    m.tables.journal_entries = m.tables.journal_entries.filter((e: any) => e.status !== 'draft')
    m.tables.bank_transactions = []
    const result = await closePeriodWithAllocation(m.admin, 'f', 'Fund I', 'u', '2027-03-01', '2027-03-31')
    const checks = m.tables.close_review_checks.map((c: any) => ({ key: c.check_key, section: c.section, label: c.label, status: c.status, detail: c.detail, evidence: c.evidence, order: c.sort_order }))
    expect({ ok: !('error' in result), error: 'error' in result ? result.error : null, checks }).toMatchInlineSnapshot(`
      {
        "checks": [
          {
            "detail": "Debits equal credits.",
            "evidence": {
              "balanced": true,
              "rows": [
                {
                  "accountId": "a-1000",
                  "balance": -50,
                  "code": "1000",
                  "credit": 50,
                  "debit": 0,
                  "name": "Cash",
                  "type": "asset",
                },
                {
                  "accountId": "a-5200",
                  "balance": 50,
                  "code": "5200",
                  "credit": 0,
                  "debit": 50,
                  "name": "Organizational expenses",
                  "type": "expense",
                },
              ],
              "totalCredits": 50,
              "totalDebits": 50,
            },
            "key": "trial_balance",
            "label": "Trial balance",
            "order": 0,
            "section": "Ledger integrity",
            "status": "passed",
          },
          {
            "detail": "No drafts fall inside the period.",
            "evidence": {
              "count": 0,
              "earliest": null,
              "items": [],
            },
            "key": "draft_entries",
            "label": "No draft journal entries",
            "order": 1,
            "section": "Ledger integrity",
            "status": "passed",
          },
          {
            "detail": "No unmatched or unposted bank activity remains.",
            "evidence": {
              "count": 0,
              "total": 0,
            },
            "key": "bank_completeness",
            "label": "Bank activity recorded",
            "order": 2,
            "section": "Cash reconciliation",
            "status": "passed",
          },
          {
            "detail": "No bank transactions are imported for this entity, so there is nothing to reconcile.",
            "evidence": {},
            "key": "bank_reconciliation",
            "label": "Bank reconciliation",
            "order": 3,
            "section": "Cash reconciliation",
            "status": "not_applicable",
          },
          {
            "detail": "-50.00 of net income through 2027-03-31 is not in any partner's capital account.",
            "evidence": {
              "unallocatedEarnings": -50,
            },
            "key": "allocation_completeness",
            "label": "Partner allocations complete",
            "order": 4,
            "section": "Partner capital",
            "status": "needs_review",
          },
          {
            "detail": "No valuation or cutoff exceptions were reported.",
            "evidence": {
              "warnings": [],
            },
            "key": "valuation_and_cutoff",
            "label": "Valuation and cutoff review",
            "order": 5,
            "section": "Investments and cutoff",
            "status": "passed",
          },
        ],
        "error": null,
        "ok": true,
      }
    `)
  })
})
