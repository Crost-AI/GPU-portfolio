// Receipts and partnership invoices over MCP / REST: the same operations as the entity's Receipts
// page (lib/accounting/receipts.ts, lib/accounting/partnership-invoices.ts). Ledger tools: the
// dispatcher resolves the entity and checks the caller may see it, management-company grant
// included for a manco. Pure metadata; handlers in receipt-tools.ts.

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'

const RECEIPT_ID = { type: 'string', description: 'receipt id from list_receipts' }

export const RECEIPT_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'list_receipts',
    description: "List the entity's receipts (emailed to the inbound address or uploaded) with what was read off each (vendor, date, total), and whether it is attached to an entry. With includeSuggestions, the first 40 unmatched receipts also carry the entries and bank transactions each most likely belongs to; get_receipt gives them for any one receipt. Receipts not yet filed under any entity are included for a caller who sees every entity. A receipt whose extraction_status is pending has not been read: read it with get_receipt and record what it says with update_receipt.",
    scope: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['unmatched', 'matched', 'dismissed', 'all'], description: 'default: everything but dismissed' },
        entryId: { type: 'string', description: 'only the receipts supporting this journal entry' },
        includeSuggestions: { type: 'boolean', description: 'add match suggestions to the first 40 unmatched receipts (default false)' },
      },
    },
  },
  {
    name: 'get_receipt',
    description: 'One receipt: its fields, a short-lived link to the file, and match suggestions. contentBase64 (files under 3 MB) is included when includeContent is true, so an assistant can read a receipt the server had no AI key to read.',
    scope: 'read',
    inputSchema: {
      type: 'object',
      required: ['receiptId'],
      properties: { receiptId: RECEIPT_ID, includeContent: { type: 'boolean' } },
    },
  },
  {
    name: 'add_receipt',
    description: "Store a receipt (PDF or image, under 3 MB, base64) on this entity, read it, and optionally attach it to an entry at once. Known fields can be passed so it is not re-read.",
    scope: 'write',
    inputSchema: {
      type: 'object',
      required: ['fileName', 'contentBase64'],
      properties: {
        fileName: { type: 'string' },
        contentBase64: { type: 'string' },
        contentType: { type: 'string', description: 'e.g. application/pdf, image/jpeg' },
        journalEntryId: { type: 'string', description: 'attach to this entry straight away' },
        vendorName: { type: 'string' }, receiptDate: { type: 'string', description: 'YYYY-MM-DD' },
        amount: { type: 'number' }, description: { type: 'string' },
      },
    },
  },
  {
    name: 'update_receipt',
    description: "Record what a receipt says (vendor, date, total, currency, description), e.g. after reading it yourself. Filing it under this entity: pass assignToThisEntity for a receipt with no entity yet.",
    scope: 'write',
    inputSchema: {
      type: 'object',
      required: ['receiptId'],
      properties: {
        receiptId: RECEIPT_ID,
        vendorName: { type: 'string' }, receiptDate: { type: 'string', description: 'YYYY-MM-DD' },
        amount: { type: 'number' }, currency: { type: 'string' }, description: { type: 'string' },
        allocationBasis: { type: 'string', description: "for a partnership expense: why the fund bears it (e.g. '100% Fund I: formation'), printed on the fund's invoice" },
        assignToThisEntity: { type: 'boolean' },
        dismissed: { type: 'boolean', description: 'true: not a receipt for the books (hides it); false: restore' },
      },
    },
  },
  {
    name: 'attach_receipt',
    description: "Attach a receipt to the journal entry it supports, or to a bank transaction that has not been drafted yet (the receipt then follows it onto its entry). detach: true takes it off again. A receipt never posts anything itself.",
    scope: 'write',
    inputSchema: {
      type: 'object',
      required: ['receiptId'],
      properties: {
        receiptId: RECEIPT_ID,
        journalEntryId: { type: 'string' },
        bankTransactionId: { type: 'string' },
        detach: { type: 'boolean' },
      },
    },
  },
  {
    name: 'draft_entry_from_receipt',
    description: "Create a DRAFT journal entry from a receipt (Dr debitAccountCode, Cr creditAccountCode for its total, dated the receipt date, vendor set) and attach the receipt. A receipt in a currency other than the fund's needs reportingAmount, its total in the fund's currency. For a charge that is not in the bank feed. billTo makes it a partnership expense paid for that fund: the debit is then this entity's 'Due from <fund>' account instead of debitAccountCode, which is what puts it on the fund's quarterly partnership invoice. Post it with post_drafts.",
    scope: 'write',
    inputSchema: {
      type: 'object',
      required: ['receiptId', 'creditAccountCode'],
      properties: {
        receiptId: RECEIPT_ID,
        debitAccountCode: { type: 'string', description: 'the expense account, e.g. 5200; not needed with billTo' },
        creditAccountCode: { type: 'string', description: 'what paid it, e.g. 1000 cash or 2000 accounts payable' },
        billTo: { type: 'string', description: 'the fund (entity name) this was paid for, as a partnership expense' },
        memo: { type: 'string' },
        reportingAmount: { type: 'number', description: "the receipt's total in the fund's currency; required when the receipt is in another currency" },
        allocationBasis: { type: 'string', description: "with billTo: why the fund bears it, kept on the receipt and printed on the invoice" },
        rememberAllocation: { type: 'boolean', description: "with billTo: also use this basis for the vendor's future expenses billed to that fund" },
      },
    },
  },
  {
    name: 'partnership_invoices',
    description: "This entity's partnership-expense invoices (sent and received), which funds have posted debits on their 'Due from <fund>' account not yet billed, and, given billTo + year + quarter, a preview of exactly what that quarter's invoice would bill (each posted debit to Due from <billTo> dated on or before the quarter's end that no invoice has billed, earlier ones flagged beforePeriod; intercompany charges such as management fees are excluded; drafts are listed as a warning).",
    scope: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        billTo: { type: 'string', description: 'entity name, for a preview' },
        year: { type: 'number' }, quarter: { type: 'number', description: '1-4' },
        from: { type: 'string', description: 'YYYY-MM-DD: read expenses dated on or after this (default: no start)' },
        through: { type: 'string', description: "YYYY-MM-DD: read expenses dated on or before this (default: the quarter's end)" },
        invoiceId: { type: 'string', description: 'one invoice with its lines' },
      },
    },
  },
  {
    name: 'create_partnership_invoice',
    description: "Bill a fund for the partnership expenses this entity paid for it in a quarter: freezes every posted, unbilled debit to this entity's 'Due from <fund>' account dated on or before the quarter's end (earlier unbilled ones included; the preview flags them beforePeriod) into a DRAFT invoice (nothing is booked yet). excludePostingIds leaves lines off; they stay open for the next invoice. issue: true also books the fund's side (Dr partnership expenses, Cr due to this entity); this entity's receivable is already on its books from each expense. When the fund pays, settle the charge on the Intercompany tab to clear the receivable. The PDF with receipts appended is at /api/accounting/partnership-invoices/<id>/pdf.",
    scope: 'write',
    inputSchema: {
      type: 'object',
      required: ['billTo', 'year', 'quarter'],
      properties: {
        billTo: { type: 'string', description: 'entity name' },
        year: { type: 'number' }, quarter: { type: 'number', description: '1-4' },
        from: { type: 'string', description: 'YYYY-MM-DD: read expenses dated on or after this (default: no start)' },
        through: { type: 'string', description: "YYYY-MM-DD: read expenses dated on or before this (default: the quarter's end)" },
        invoiceDate: { type: 'string', description: 'YYYY-MM-DD; default today' },
        memo: { type: 'string' },
        issue: { type: 'boolean', description: 'default false: leave it as a draft to review' },
        allocations: { type: 'object', additionalProperties: { type: 'string' }, description: "allocation basis per line, keyed by postingId from the preview; replaces the one the line started with (the receipt's, else the vendor's saved basis)" },
        rememberPostingIds: { type: 'array', items: { type: 'string' }, description: "lines whose basis is saved for that vendor's future expenses billed to this fund" },
        excludePostingIds: { type: 'array', items: { type: 'string' }, description: 'postingId values from the preview to leave off this invoice' },
        dueFromAccount: { type: 'string', description: "optional account code on this entity's chart to use as the 'Due from <billTo>' account from now on (for a chart imported with its own names, e.g. an account called 'Due from Fund III' under a plain code). It is linked to billTo before the quarter is read." },
      },
    },
  },
  {
    name: 'issue_partnership_invoice',
    description: 'Issue a draft partnership invoice: book the fund\'s side (Dr partnership expenses, Cr due to this entity) as an intercompany expense reimbursement. void: true instead voids it and releases its expenses for the next invoice (an issued one needs the fund\'s entry voided first, and a paid one cannot be voided).',
    scope: 'write',
    inputSchema: {
      type: 'object',
      required: ['invoiceId'],
      properties: { invoiceId: { type: 'string' }, void: { type: 'boolean' } },
    },
  },
  {
    name: 'edit_partnership_invoice',
    description: 'Correct the allocation basis on a draft or issued partnership invoice in place: same number, amounts and bookings; the PDF shows the new text. allocations maps posting id (from partnership_invoices with invoiceId) to the basis; an empty string clears it. rememberPostingIds also saves those lines\' bases for that vendor\'s future expenses billed to the same fund.',
    scope: 'write',
    inputSchema: {
      type: 'object',
      required: ['invoiceId', 'allocations'],
      properties: {
        invoiceId: { type: 'string' },
        allocations: { type: 'object', additionalProperties: { type: 'string' } },
        rememberPostingIds: { type: 'array', items: { type: 'string' } },
      },
    },
  },
]
