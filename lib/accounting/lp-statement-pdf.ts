// LP capital account statement → PDF.
//
// Same fund chrome as the investor report and the LP letter (logo left, fund name
// and address right, rule-and-note footer) so the three LP-facing PDFs read as one
// family. Rendered through the shared HTML → headless-Chrome pipeline.
//
// WHY THIS ONE GETS STORED. Snapshot PDFs are re-rendered from data on every
// download. That's fine for a snapshot, but a capital account statement is a
// point-in-time record an LP may have filed with their accountant. If it re-rendered
// from the ledger, reopening a period or amending an entry would silently change a
// statement that was already sent. So the publish route writes the Buffer to the
// `lp-documents` bucket and shares the stored file — the numbers are frozen at the
// moment you publish.

import { renderHtmlToPdf } from '@/lib/lp-report-pdf'
import { pdfFontCss, PDF_SANS, PDF_DISPLAY } from '@/lib/pdf-fonts'
import { displayFontOf } from '@/lib/theme'
import { getCurrencySymbol } from '@/lib/currency'
import { lpStatement, lpCapitalSummary } from './capital-calls'
import { lastDataDate } from './lp-positions'
import { CAPITAL_ACCOUNT_LABELS, ACTIVITY_FIELDS, type CapitalAccount } from './capital-account'
import type { CapitalPeriod } from './capital-account'
import type { StatementPeriod } from './statement-period'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadFofRaw, computeFofFromRaw } from '@/lib/portfolio/fof-load'
import { commitmentSchedule, performanceTable } from '@/lib/portfolio/fof-exhibits'
import { valuationBasisNote } from '@/lib/portfolio/fof-valuation'
import { documentLetterhead } from '@/lib/vehicle-letterhead'

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** Accounting convention: negatives in parentheses, a dash for exactly zero. */
function money(v: number | null, currency: string): string {
  if (v == null) return '—'
  if (Math.abs(v) < 0.005) return '—'
  const n = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  // Was `currency === 'USD' ? '$' : ''` — so a EUR fund's LP statement showed bare numbers with
  // no unit at all, on the one document an LP is most likely to file with their accountant.
  const sym = getCurrencySymbol(currency)
  return v < 0 ? `(${sym}${n})` : `${sym}${n}`
}

const pct = (v: number) => `${(v * 100).toFixed(3)}%`

/** The roll-forward lines that make up the partner's profit and loss, in statement order. Carried
 *  interest stays outside: it reallocates profit between partners rather than earning it. */
export const PNL_FIELDS: (keyof CapitalAccount)[] = [
  'managementFees', 'expenses', 'operatingIncome', 'realizedGains', 'unrealizedGains', 'fxTranslation',
]
/** Capital movements printed above the profit and loss block. */
const PRE_PNL_FIELDS: (keyof CapitalAccount)[] = ['contributions', 'distributions']
export const NET_PNL_LABEL = 'Net profit / (loss)'

/** Contributions and distributions are the movements an LP actually cares to see listed. */
const TXN_LABELS: Record<string, string> = {
  capital_call: 'Capital contribution',
  contribution: 'Capital contribution',
  contribution_funding: 'Capital contribution',
  opening_balance: 'Opening capital',
  distribution: 'Distribution',
  transfer: 'Transfer',
}

export interface StatementPdfData {
  /** Fund's display face (FundTheme.displayFont). Absent = Newsreader. */
  displayFont?: string | null
  fundName: string
  fundLogo: string | null
  fundAddress: string | null
  currency: string
  vehicle: string
  partnerName: string
  period: StatementPeriod
  row: { commitment: number; called: number | null; funded: number | null; outstanding: number | null; receivable: number | null; ending: number | null }
  periodRollForward: CapitalAccount
  /** January 1 of the period's year through the period end. Absent or null (a statement that is
   *  itself year to date) prints two columns. */
  ytdRollForward?: CapitalAccount | null
  rollForward: CapitalAccount
  transactions: { date: string; memo: string | null; sourceType: string | null; amount: number }[]
  ownership: number
  /** When this vehicle's underlying data was last updated (footnote). Vehicles report on
   *  irregular cadences, so the reporting PERIOD and the last-updated date are not the same. */
  dataAsOf?: string | null
  /**
   * Fund-of-funds exhibits. OPTIONAL and absent unless the fund holds funds, so a statement
   * for an ordinary fund is byte-identical to before.
   *
   * The SCHEDULE OF INVESTMENTS is deliberately NOT here: this document is the partner's
   * capital account, and the SOI already reaches them through the fund financials. What does
   * belong is the valuation note — an LP reading a NAV struck 92 days ago is entitled to know
   * that, and it is the disclosure an auditor looks for.
   */
  fof?: {
    commitments: { rows: { name: string; commitment: number; called: number; unfunded: number }[]
                   totals: { commitment: number; called: number; unfunded: number } }
    performance: { rows: { name: string; vintageYear: number | null; contributed: number; distributed: number; nav: number; tvpi: number | null }[] }
    valuationNote: { name: string; navAsOf: string | null; basis: string; stalenessDays: number | null }[]
  }
}

/**
 * The fund-of-funds exhibits, appended to a partner's statement. Empty string when the fund
 * holds no funds, so nothing about an ordinary statement changes.
 */
function fofSection(d: StatementPdfData): string {
  if (!d.fof) return ''
  const m = (v: number | null) => money(v, d.currency)
  const mult = (v: number | null) => (v === null || v === undefined ? '&mdash;' : `${v.toFixed(2)}x`)
  const th = 'padding:5px 8px;border-bottom:1px solid #e5e5e5;text-align:right;font-weight:600;'
  const thL = th.replace('right', 'left')
  const td = 'padding:5px 8px;border-top:1px solid #e5e5e5;text-align:right;font-variant-numeric:tabular-nums;'
  const tdL = 'padding:5px 8px;border-top:1px solid #e5e5e5;'

  const commit = d.fof.commitments
  return `
    <h2 style="font-size:13px;margin:24px 0 8px;">Commitments to underlying funds</h2>
    <table style="width:100%;border-collapse:collapse;font-size:11px;">
      <thead><tr>
        <th style="${thL}">Fund</th><th style="${th}">Commitment</th>
        <th style="${th}">Called</th><th style="${th}">Unfunded</th>
      </tr></thead>
      <tbody>
        ${commit.rows.map(r => `<tr>
          <td style="${tdL}">${esc(r.name)}</td>
          <td style="${td}">${m(r.commitment)}</td>
          <td style="${td}">${m(r.called)}</td>
          <td style="${td}">${m(r.unfunded)}</td>
        </tr>`).join('')}
        <tr style="font-weight:600;">
          <td style="${tdL}">Total</td>
          <td style="${td}">${m(commit.totals.commitment)}</td>
          <td style="${td}">${m(commit.totals.called)}</td>
          <td style="${td}">${m(commit.totals.unfunded)}</td>
        </tr>
      </tbody>
    </table>

    <h2 style="font-size:13px;margin:24px 0 8px;">Underlying fund performance</h2>
    <table style="width:100%;border-collapse:collapse;font-size:11px;">
      <thead><tr>
        <th style="${thL}">Fund</th><th style="${th}">Vintage</th><th style="${th}">Contributed</th>
        <th style="${th}">Distributed</th><th style="${th}">NAV</th><th style="${th}">TVPI</th>
      </tr></thead>
      <tbody>
        ${d.fof.performance.rows.map(r => `<tr>
          <td style="${tdL}">${esc(r.name)}</td>
          <td style="${td}">${r.vintageYear ?? '&mdash;'}</td>
          <td style="${td}">${m(r.contributed)}</td>
          <td style="${td}">${m(r.distributed)}</td>
          <td style="${td}">${m(r.nav)}</td>
          <td style="${td}">${mult(r.tvpi)}</td>
        </tr>`).join('')}
      </tbody>
    </table>

    <h2 style="font-size:13px;margin:24px 0 8px;">Basis of valuation</h2>
    <p style="font-size:10px;color:#666;margin:0 0 8px;">
      Each position is carried at the manager&rsquo;s most recent reported net asset value, adjusted
      for capital called and distributions received between that valuation date and the
      reporting date.
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:11px;">
      <thead><tr>
        <th style="${thL}">Fund</th><th style="${thL}">NAV as of</th>
        <th style="${thL}">Basis</th><th style="${th}">Days stale</th>
      </tr></thead>
      <tbody>
        ${d.fof.valuationNote.map(r => `<tr>
          <td style="${tdL}">${esc(r.name)}</td>
          <td style="${tdL}">${r.navAsOf ? esc(r.navAsOf) : 'No statement received'}</td>
          <td style="${tdL}">${r.basis === 'unreported' ? 'Carried at cost' : esc(r.basis)}</td>
          <td style="${td}">${r.stalenessDays ?? '&mdash;'}</td>
        </tr>`).join('')}
      </tbody>
    </table>`
}

export function buildStatementHtml(d: StatementPdfData): string {
  const { currency, displayFont } = d
  const m = (v: number | null) => money(v, currency)

  // The columns, left to right: the statement period, year to date when it says something the
  // period doesn't, and inception to date.
  const accounts = [d.periodRollForward, ...(d.ytdRollForward ? [d.ytdRollForward] : []), d.rollForward]

  // Only show a line if it moved in ANY column — an SPV shouldn't print four empty rows.
  const lines = ACTIVITY_FIELDS.filter(f => accounts.some(a => Math.abs(a[f]) > 0.004))

  const cell = (v: string) =>
    `<td style="padding:6px 8px;border-top:1px solid #e5e5e5;text-align:right;font-variant-numeric:tabular-nums;">${v}</td>`
  const row = (label: string, values: number[], style: 'plain' | 'total' | 'subtotal' | 'component' = 'plain') => `
    <tr${style === 'total' ? ' style="font-weight:600;background:#fafafa;"' : style === 'subtotal' ? ' style="font-weight:600;"' : ''}>
      <td style="padding:6px 8px${style === 'component' ? ' 6px 22px' : ''};border-top:1px solid #e5e5e5;${style === 'component' ? 'color:#555;' : ''}">${esc(label)}</td>
      ${values.map(v => cell(m(v))).join('')}
    </tr>`
  const field = (f: keyof CapitalAccount) => accounts.map(a => a[f])

  // The partner's share of the fund's profit and loss — management fees, expenses, income and
  // gains — indented under one subtotal, so an LP reads a single profit-or-loss figure the way a
  // hand-built statement shows it. The rows that are not indented still sum to ending capital.
  const pnlShown = lines.filter(f => PNL_FIELDS.includes(f))
  const sumPnl = (a: CapitalAccount) => PNL_FIELDS.reduce((s, f) => s + a[f], 0)
  const rollForwardRows = [
    row(CAPITAL_ACCOUNT_LABELS.beginning, field('beginning')),
    ...lines.filter(f => !PNL_FIELDS.includes(f) && PRE_PNL_FIELDS.includes(f))
      .map(f => row(CAPITAL_ACCOUNT_LABELS[f], field(f))),
    ...pnlShown.map(f => row(CAPITAL_ACCOUNT_LABELS[f], field(f), 'component')),
    ...(pnlShown.length > 0 ? [row(NET_PNL_LABEL, accounts.map(sumPnl), 'subtotal')] : []),
    ...lines.filter(f => !PNL_FIELDS.includes(f) && !PRE_PNL_FIELDS.includes(f))
      .map(f => row(CAPITAL_ACCOUNT_LABELS[f], field(f))),
    row(CAPITAL_ACCOUNT_LABELS.ending, field('ending'), 'total'),
  ].join('')

  const txns = d.transactions.filter(t => {
    const st = t.sourceType ?? ''
    return st === 'capital_call' || st === 'contribution' || st === 'contribution_funding'
      || st === 'distribution' || st === 'opening_balance' || st === 'transfer'
  })

  const txnSection = txns.length === 0 ? '' : `
    <h3 style="font-size:12px;font-weight:600;margin:24px 0 6px;">Contributions and distributions in the period</h3>
    <table>
      <thead>
        <tr>
          <th style="width:90px;">Date</th>
          <th>Description</th>
          <th style="text-align:right;width:120px;">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${txns.map(t => `
          <tr>
            <td style="padding:5px 8px;border-top:1px solid #e5e5e5;font-variant-numeric:tabular-nums;">${esc(t.date)}</td>
            <td style="padding:5px 8px;border-top:1px solid #e5e5e5;">${esc(TXN_LABELS[t.sourceType ?? ''] ?? t.memo ?? 'Capital movement')}</td>
            <td style="padding:5px 8px;border-top:1px solid #e5e5e5;text-align:right;font-variant-numeric:tabular-nums;">${m(t.amount)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`

  // Capital is recognized when it is CALLED, not when the cash lands — which is why
  // "Called capital" is the headline and matches the contributions line in the
  // roll-forward above. This used to print `funded` as "Contributed capital", so the
  // summary and the roll-forward disagreed by exactly the receivable whenever a call was
  // outstanding. The receivable now gets its own line whenever there is one, rather than
  // being suppressed by a comparison against a figure it used to be double-counted in.
  //
  // Laid out in the roll-forward's columns. Capital called is a flow, so it has a figure for each;
  // the rest are balances at the period end and sit under inception to date only.
  const blank = accounts.slice(1).map(() => '')
  const summary: [string, string[]][] = [
    ['Commitment', [...blank, m(d.row.commitment)]],
    ['Called capital', [
      ...accounts.slice(0, -1).map(a => m(a.contributions)),
      m(d.row.called),
    ]],
    ...(Math.abs(d.row.receivable ?? 0) > 0.004
      ? [['— of which not yet funded', [...blank, m(d.row.receivable)]] as [string, string[]]]
      : []),
    ['Remaining to be called', [...blank, m(d.row.outstanding)]],
    ['Ownership', [...blank, pct(d.ownership)]],
    ['Ending capital (NAV)', [...blank, m(d.row.ending)]],
  ]
  const columnHeads = ['Statement period', ...(d.ytdRollForward ? ['Year to date'] : []), 'Inception to date']

  const periodLabel = d.period.start && d.period.end
    ? `${d.period.label} (${d.period.start} to ${d.period.end})`
    : d.period.label

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>${pdfFontCss(displayFont)}
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: ${PDF_SANS}; font-size:12px; color:#111; line-height:1.4; }
  table { width:100%; border-collapse:collapse; font-size:11px; }
  th { font-weight:600; text-align:left; padding:5px 8px; border-bottom:2px solid #ccc; color:#555; }
</style></head><body>
  <div style="padding-bottom:40px;">
    <!-- Fund header — identical to the investor report and LP letter -->
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:32px;">
      <div style="flex-shrink:0;">
        ${d.fundLogo ? `<img src="${d.fundLogo}" style="height:40px;width:auto;object-fit:contain;" />` : ''}
      </div>
      <div style="text-align:right;margin-left:40%;">
        <h2 style="font-family:${PDF_DISPLAY};font-size:17px;font-weight:400;letter-spacing:-0.01em;">${esc(d.fundName)}</h2>
        ${d.fundAddress ? `<p style="font-size:11px;color:#888;white-space:pre-line;line-height:1.3;margin-top:2px;">${esc(d.fundAddress)}</p>` : ''}
      </div>
    </div>

    <h1 style="font-family:${PDF_DISPLAY};font-size:22px;font-weight:400;letter-spacing:-0.01em;margin-bottom:3px;">Capital Account Statement</h1>
    <p style="font-size:14px;font-weight:600;color:#111;">${esc(d.partnerName)}</p>
    <p style="font-size:11px;color:#888;margin-bottom:22px;">${esc(d.vehicle)} &middot; ${esc(periodLabel)}</p>

    <!-- Roll-forward -->
    <table>
      <thead>
        <tr>
          <th></th>
          ${columnHeads.map(h => `<th style="text-align:right;width:130px;">${h}</th>`).join('')}
        </tr>
      </thead>
      <tbody>${rollForwardRows}</tbody>
    </table>

    <!-- Commitment summary -->
    <h3 style="font-size:12px;font-weight:600;margin:24px 0 6px;">Commitment summary</h3>
    <table>
      <tbody>
        ${summary.map(([k, vs]) => `
          <tr>
            <td style="padding:5px 8px;border-top:1px solid #e5e5e5;">${esc(k)}</td>
            ${vs.map(v => `<td style="padding:5px 8px;border-top:1px solid #e5e5e5;text-align:right;font-variant-numeric:tabular-nums;width:130px;">${v}</td>`).join('')}
          </tr>`).join('')}
      </tbody>
    </table>

    ${txnSection}
    ${fofSection(d)}
  </div>

  <div style="position:fixed;bottom:0;left:0;right:0;padding:8px 0;border-top:1px solid #e5e5e5;background:white;font-size:9px;color:#888;">
    Capital account statement for ${esc(d.partnerName)} in ${esc(d.vehicle)}. Prepared from the fund's books of account.
    Figures are stated in ${esc(currency)} and reflect the period shown.${d.dataAsOf ? ` Underlying data for ${esc(d.vehicle)} was last updated ${esc(d.dataAsOf)}.` : ''} This statement is unaudited and may be subject to further adjustment; it should not be used for tax purposes. It is provided to limited partners for informational purposes.
  </div>
</body></html>`
}

/**
 * The year-to-date window for a statement: January 1 of the period end's year (today's, for an
 * open-ended period) through the period end. A Q1 statement's YTD column repeats its period column,
 * as a hand-built statement's does; only a statement that is itself year to date drops it.
 */
export function ytdWindow(period: StatementPeriod, today: Date = new Date()): CapitalPeriod | null {
  if (period.preset === 'ytd') return null
  const end = period.end ?? today.toISOString().slice(0, 10)
  return { start: `${end.slice(0, 4)}-01-01`, end }
}

/**
 * One LP's capital account statement, rendered to a PDF. Mirrors generateLetterPdf.
 * The CALLER is responsible for authorization.
 */
export async function generateLpStatementPdf(
  admin: SupabaseClient,
  opts: { fundId: string; group: string; lpEntityId: string; period: StatementPeriod },
): Promise<{ pdf: Buffer; fileName: string; partnerName: string } | null> {
  const { fundId, group, lpEntityId, period } = opts

  const capitalPeriod: CapitalPeriod = { start: period.start, end: period.end }
  const ytd = ytdWindow(period)
  const [statement, ytdStatement, fundRes, settingsRes] = await Promise.all([
    lpStatement(admin, fundId, group, lpEntityId, capitalPeriod),
    // Same window as the period (a Q1 or full-year statement): no second pass over the ledger.
    ytd && !(ytd.start === period.start && ytd.end === period.end)
      ? lpStatement(admin, fundId, group, lpEntityId, ytd)
      : Promise.resolve(null),
    admin.from('funds' as any).select('name, logo_url, address').eq('id', fundId).maybeSingle(),
    admin.from('fund_settings' as any).select('currency, theme').eq('fund_id', fundId).maybeSingle(),
  ])

  if ('error' in statement) return null

  const fund = (fundRes as any).data
  // The vehicle's own letterhead where it has one (a separately branded vehicle's LPs know it by
  // that brand), else the fund's. Logos are data URIs only: a remote URL fails in headless Chrome.
  const letterhead = await documentLetterhead(admin, fundId, fund, [group])
  const currency = (settingsRes as any).data?.currency || 'USD'

  // Ownership by commitment, which is the basis the close allocates on. The total MUST use the
  // same resolver as the per-LP row (resolveCommitmentMap, via lpCapitalSummary) — summing the
  // raw lp_investments scalar here would disagree with the numerator for any event-only partner.
  const summary = await lpCapitalSummary(admin, fundId, group)
  const totalCommitment = summary.reduce((s, r) => s + r.commitment, 0)
  const ownership = totalCommitment > 0 ? statement.row.commitment / totalCommitment : 0

  const dataAsOf = await lastDataDate(admin, fundId, group)

  // Fund-of-funds exhibits, only when the fund actually holds funds. loadFofRaw returns null
  // otherwise, so the statement for an ordinary fund is unchanged.
  const fofRaw = await loadFofRaw(admin, fundId, group)
  const fof = fofRaw
    ? (() => {
        // period.end is nullable on an inception-to-date window; fall back to today, which
        // is what "as of now" means for a statement with no closing date.
        const { positions } = computeFofFromRaw(fofRaw, period.end ?? new Date().toISOString().slice(0, 10))
        return {
          commitments: commitmentSchedule(positions, 0),
          performance: performanceTable(positions),
          valuationNote: valuationBasisNote(positions),
        }
      })()
    : undefined

  const html = buildStatementHtml({
    displayFont: displayFontOf(settingsRes.data?.theme),
    fundName: letterhead.name,
    fundLogo: letterhead.logo,
    fundAddress: letterhead.address,
    currency,
    vehicle: group,
    partnerName: statement.row.name,
    period,
    row: statement.row,
    periodRollForward: statement.periodRollForward,
    ytdRollForward: !ytd ? null
      : ytdStatement ? ('error' in ytdStatement ? null : ytdStatement.periodRollForward)
      : statement.periodRollForward,
    rollForward: statement.rollForward,
    transactions: statement.transactions,
    ownership,
    dataAsOf,
    fof,
  })

  const pdf = await renderHtmlToPdf(html)
  const safe = (s: string) => String(s || '').replace(/[^a-zA-Z0-9 _-]/g, '').trim()
  const fileName = `${safe(statement.row.name) || 'Partner'} - Capital Account Statement - ${safe(period.label) || 'Period'}.pdf`

  return { pdf, fileName, partnerName: statement.row.name }
}
