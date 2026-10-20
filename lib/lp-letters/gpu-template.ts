// The quarterly investor letter of a GPU SPV (pivot plan §5.4): a sibling of the default template,
// for an operating business with investors rather than a portfolio of companies. Its figures come
// from the brief's `fleet` block (lib/lp-letters/brief.ts), built from lib/gpu/report.ts.

export const GPU_QUARTERLY_TEMPLATE_NAME = 'GPU quarterly'

export const GPU_QUARTERLY_STYLE_GUIDE = `## Investor Letter Style Guide (GPU quarterly)

### Structure
1. Header: SPV name, quarter, date
2. Opening: "Dear Investors" + one paragraph on the quarter
3. Fleet: servers in service, utilisation and uptime where the brief states them; revenue for the quarter
4. Distributions and your position: capital returned to date, capital still unreturned, preferred return paid and
   carried forward, the manager's profit share PAID, DPI and IRR to date
5. Profit share: "Paid" as booked, and "Accrued (memo, not booked)" only where the brief carries it — always labelled
   a memo, never described as earned, owed or paid
6. Outlook: the projected outcome only where the brief states one, labelled as a forecast
7. Closing: placeholder for the manager's outlook

### Tone
- Professional, plain, numbers first
- First person plural ("We", "The SPV")
- Equipment is stated at cost and net book value; revenue is gross rental revenue before the management fee
- Concise — no filler language
`
