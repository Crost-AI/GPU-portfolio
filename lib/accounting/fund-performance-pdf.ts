// The fund performance report as a PDF, in the layout LPs are used to from Carta: the dated
// contributions and distributions, the NAV as the last row, then the LP-only returns. Rendered
// from the same report object as the screen (fund-performance.ts). Pure HTML builder; the route
// renders it through renderHtmlToPdf.

import { pdfFontCss, PDF_SANS, PDF_DISPLAY } from '@/lib/pdf-fonts'
import { performanceMoney, performanceMultiple, performancePct, type FundPerformanceReport } from './fund-performance-format'

export interface FundPerformancePdfMeta {
  currency: string
  displayFont?: string | null
  /** ISO timestamp, printed in the footer. */
  generatedAt: string
}

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const TD = 'padding:5px 8px;border-top:1px solid #e5e5e5;'
const NUM = `${TD}text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;`

export function buildFundPerformanceHtml(r: FundPerformanceReport, meta: FundPerformancePdfMeta): string {
  const m = (v: number | null | undefined, dp = 0) => performanceMoney(v, meta.currency, dp)
  const { metrics } = r

  const flowRows = r.rows.map(row => `<tr>
      <td style="${TD}">${esc(row.label)}</td>
      <td style="${NUM}">${m(row.contributions)}</td>
      <td style="${NUM}">${m(row.distributions)}</td>
      <td style="${NUM}">${m(row.net)}</td>
    </tr>`).join('')

  const summary = (label: string, value: string) =>
    `<tr><td style="${TD}font-weight:600;">${esc(label)}</td><td style="${NUM}font-weight:600;">${value}</td></tr>`

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>${pdfFontCss(meta.displayFont)}
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: ${PDF_SANS}; font-size:11px; color:#111; line-height:1.4; }
  table { width:100%; border-collapse:collapse; font-size:10.5px; }
  th { font-weight:600; text-align:left; padding:5px 8px; border-bottom:2px solid #ccc; color:#555; vertical-align:bottom; }
</style></head><body>
  <div style="margin-bottom:22px;border-bottom:1px solid #e5e5e5;padding-bottom:10px;">
    <h1 style="font-family:${PDF_DISPLAY};font-size:20px;font-weight:400;letter-spacing:-0.01em;">Fund Performance Report</h1>
    <p style="font-size:12px;color:#333;">${esc(r.vehicle)}</p>
    <p style="font-size:11px;color:#555;">Through ${esc(r.periodLabel)}</p>
  </div>

  <table>
    <thead><tr>
      <th>Date</th>
      <th style="text-align:right;width:140px;">Contribution</th>
      <th style="text-align:right;width:140px;">Distribution</th>
      <th style="text-align:right;width:140px;">Net</th>
    </tr></thead>
    <tbody>
      ${flowRows}
      <tr>
        <td style="${TD}">${esc(r.asOf)} <span style="color:#888;">net asset value</span></td>
        <td style="${NUM}"></td>
        <td style="${NUM}"></td>
        <td style="${NUM}">${m(r.totals.nav)}</td>
      </tr>
      <tr style="font-weight:600;background:#fafafa;">
        <td style="${TD}">Total</td>
        <td style="${NUM}">${m(r.totals.contributions)}</td>
        <td style="${NUM}">${m(r.totals.distributions)}</td>
        <td style="${NUM}">${m(r.totals.net)}</td>
      </tr>
    </tbody>
  </table>

  <table style="margin-top:22px;width:60%;margin-left:auto;">
    <tbody>
      ${summary('Net IRR (LP only)', performancePct(metrics.irr))}
      ${summary('TVPI (LP only)', performanceMultiple(metrics.tvpi))}
      ${summary('DPI (LP only)', performanceMultiple(metrics.dpi))}
      ${summary('RVPI (LP only)', performanceMultiple(metrics.rvpi))}
    </tbody>
  </table>

  <table style="margin-top:14px;width:60%;margin-left:auto;">
    <tbody>
      ${summary('Total Value (LP only)', m(metrics.totalValue, 2))}
      ${summary('Net Asset Value (LP only)', m(metrics.nav, 2))}
      ${summary('Distributions (LP only)', m(metrics.distributions, 2))}
      ${summary('Capital Contributions (LP only)', m(metrics.contributions, 2))}
    </tbody>
  </table>

  ${r.notes.map(n => `<p style="font-size:10px;color:#a2600e;margin-top:10px;">${esc(n)}</p>`).join('')}

  <div style="position:fixed;bottom:0;left:0;right:0;padding:6px 0;border-top:1px solid #e5e5e5;background:white;font-size:8.5px;color:#888;">
    ${esc(r.vehicle)} · stated in ${esc(meta.currency)} · generated ${esc(meta.generatedAt.slice(0, 10))}. Limited partners only; the general partner's capital is excluded.
    Net asset value is the limited partners' capital per the books at ${esc(r.asOf)}. IRR is computed on the exact transaction dates, with the net asset value as the final inflow.
  </div>
</body></html>`
}
