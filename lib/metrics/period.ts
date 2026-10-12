/**
 * A reporting period as a person or an assistant writes it ("Q3 2026", "Sep 2026", "2026-09",
 * "FY2025") turned into the label, year, quarter and month a metric value is stored under.
 * Null when it can't be read, so the caller asks rather than guessing.
 */
export interface MetricPeriod { label: string; year: number; quarter?: number; month?: number }

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MONTH_LABEL = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const year = (s: string) => {
  const n = Number(s)
  return n >= 1990 && n <= 2100 ? n : null
}

export function parseMetricPeriod(raw: unknown): MetricPeriod | null {
  const s = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  if (!s) return null
  let m: RegExpMatchArray | null

  // Q3 2026, Q3-2026, Q3'26 is not accepted (ambiguous century); 2026 Q3, 2026-Q3
  if ((m = s.match(/^q([1-4])[\s\-/]*(\d{4})$/)) || (m = s.match(/^(\d{4})[\s\-/]*q([1-4])$/))) {
    const [q, y] = s.startsWith('q') ? [Number(m[1]), year(m[2])] : [Number(m[2]), year(m[1])]
    return y ? { label: `Q${q} ${y}`, year: y, quarter: q } : null
  }
  // 2026-09, 2026/9
  if ((m = s.match(/^(\d{4})[-/](\d{1,2})$/))) {
    const y = year(m[1]); const mo = Number(m[2])
    return y && mo >= 1 && mo <= 12 ? { label: `${MONTH_LABEL[mo - 1]} ${y}`, year: y, month: mo } : null
  }
  // Sep 2026, September 2026
  if ((m = s.match(/^([a-z]{3,9})\.? (\d{4})$/))) {
    const mo = MONTHS.indexOf(m[1].slice(0, 3)) + 1; const y = year(m[2])
    return y && mo > 0 && MONTHS[mo - 1] === m[1].slice(0, 3) ? { label: `${MONTH_LABEL[mo - 1]} ${y}`, year: y, month: mo } : null
  }
  // FY2025, FY 2025, 2025
  if ((m = s.match(/^(?:fy ?)?(\d{4})$/))) {
    const y = year(m[1])
    return y ? { label: s.startsWith('fy') ? `FY${y}` : String(y), year: y } : null
  }
  return null
}
