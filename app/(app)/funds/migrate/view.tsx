'use client'

import { ImportReviewPanel } from '@/components/accounting/import-review'
import type { ImportReview } from '@/lib/accounting/import-review'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, CheckCircle2, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useCurrency, formatCurrencyPrice } from '@/components/currency-context'
import { Input } from '@/components/ui/input'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { suggestAccount, type AccountSuggestion } from '@/lib/accounting/quickbooks/suggest-account'

interface Proposal {
  qbAccount: string
  code: string | null
  confidence: 'exact' | 'likely' | 'none'
  reason: string
  suggestsHolding: string | null
  lineCount: number
  excluded?: boolean
}

interface DedupeNote { entryDate: string; memo: string | null; reason: string }

interface ParseResult {
  group: string
  transactionCount: number
  dateRange: { first: string; last: string } | null
  accounts: Proposal[]
  mappedCount: number
  excludedCount: number
  discoveredHoldings: string[]
  errors: string[]
}

interface TieOutResult {
  asOf: string
  ties: boolean
  lines: { code: string; name: string; ours: number; theirs: number; difference: number }[]
  ourTotal: number
  theirTotal: number
  includesDrafts: boolean
  unmappedAccounts: string[]
  quickBooksOnly?: { ties: boolean; differenceCount: number }
  openingEntries?: { id: string; date: string; memo: string | null; status: string; cash: number }[]
}

/**
 * The four-step QuickBooks migration, in order, each step gating the next. The order is what
 * makes the migration safe — mapping before import, import before tie-out, tie-out before the
 * cut-over date is set — so the UI exists partly to make it hard to do out of sequence.
 */
export function MigrateView({ group }: { group: string }) {
  const currency = useCurrency()
  const fmt = (v: number) => formatCurrencyPrice(v, currency)

  const [capitalWarnings, setCapitalWarnings] = useState<string[]>([])
  const [matches, setMatches] = useState<{ duplicates: DedupeNote[]; recovered: DedupeNote[] }>({ duplicates: [], recovered: [] })
  const [journalText, setJournalText] = useState('')
  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [chart, setChart] = useState<{ code: string; name: string }[]>([])
  const [newAccount, setNewAccount] = useState<(AccountSuggestion & { qbAccount: string }) | null>(null)
  const [holdingTypes, setHoldingTypes] = useState<Record<string, string>>({})
  const [mappingSaved, setMappingSaved] = useState(false)
  const [mappingExpanded, setMappingExpanded] = useState(false)
  const mappingToggle = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  const [importReview, setImportReview] = useState<ImportReview | null>(null)
  const [dryRun, setDryRun] = useState<any>(null)
  const [runs, setRuns] = useState<any[]>([])

  const [tbText, setTbText] = useState('')
  const [tbAsOf, setTbAsOf] = useState('')
  const [tieOut, setTieOut] = useState<TieOutResult | null>(null)

  const loadChart = useCallback(async () => {
    const res = await fetch(`/api/accounting/chart${group ? `?group=${encodeURIComponent(group)}` : ''}`)
    // /api/accounting/chart returns a bare array, not { accounts: [...] }.
    const json = await res.json().catch(() => [])
    const rows = Array.isArray(json) ? json : (json?.accounts ?? [])
    if (!res.ok) throw new Error(json?.error ?? 'Could not load accounts.')
    const active = rows.filter((a: any) => a.is_active !== false)
    setChart(active.map((a: any) => ({ code: a.code, name: a.name })))
  }, [group])

  const loadRuns = useCallback(async () => {
    const res = await fetch(`/api/accounting/quickbooks/import${group ? `?group=${encodeURIComponent(group)}` : ''}`)
    const json = await res.json().catch(() => ({}))
    setRuns(json?.runs ?? [])
  }, [group])

  useEffect(() => {
    // Both loaders update state only after their network requests resolve.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void Promise.all([loadChart(), loadRuns()]).catch(e => setStatus(e.message))
  }, [loadChart, loadRuns])

  useEffect(() => {
    if (mappingSaved && !mappingExpanded) mappingToggle.current?.focus()
  }, [mappingSaved, mappingExpanded])

  async function post(url: string, body: unknown) {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group, ...(body as object) }),
    })
    return { ok: res.ok, json: await res.json().catch(() => ({})) }
  }

  async function runParse() {
    setBusy(true); setStatus(null)
    try {
      const { ok, json } = await post('/api/accounting/quickbooks/parse', { text: journalText })
      if (!ok) { setStatus(json?.error ?? 'Could not parse.'); return }
      setParsed(json)
      setMappingSaved(false); setDryRun(null); setTieOut(null); setNewAccount(null)
      setMapping(Object.fromEntries(json.accounts.map((a: Proposal) => [a.qbAccount, a.excluded ? '__exclude__' : (a.code ?? '')])))
    } catch (e) { setStatus(e instanceof Error ? e.message : 'Request failed.') } finally { setBusy(false) }
  }

  async function saveMapping() {
    setBusy(true); setStatus(null)
    try {
      const rows = Object.entries(mapping).map(([qbAccount, accountCode]) => ({
        qbAccount, accountCode: accountCode === '__exclude__' ? null : accountCode, excluded: accountCode === '__exclude__',
      }))
      const res = await fetch('/api/accounting/quickbooks/mapping', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group, rows }),
      })
      const json = await res.json()
      setMappingSaved(res.ok)
      if (res.ok) {
        setMappingExpanded(false)
        setNewAccount(null)
        setStatus(null)
      } else setStatus(json?.error ?? 'Could not save.')
    } catch (e) { setStatus(e instanceof Error ? e.message : 'Request failed.') } finally { setBusy(false) }
  }

  async function discoverHoldings() {
    if (!parsed) return
    setBusy(true); setStatus(null)
    try {
      const { ok, json } = await post('/api/accounting/quickbooks/mapping/discover', {
        holdings: pendingHoldings, holdingTypes,
      })
      if (!ok) { setStatus(json?.error ?? 'Could not create holdings.'); return }
      const bits = [`${json.created.length} created`]
      if (json.existing.length) bits.push(`${json.existing.length} already existed`)
      if (json.errors.length) bits.push(`${json.errors.length} failed`)
      await loadChart()
      const codes = new Map<string, string>((json.mappings ?? []).map((m: { name: string; code: string }) => [m.name, m.code]))
      setMapping(m => {
        const next = { ...m }
        for (const a of parsed.accounts) {
          const code = a.suggestsHolding && codes.get(a.suggestsHolding)
          if (code && (!next[a.qbAccount] || next[a.qbAccount] === '1100')) next[a.qbAccount] = code
        }
        return next
      })
      setMappingSaved(false); setDryRun(null); setTieOut(null)
      setStatus(bits.join(', ') + '.' + (json.errors.length ? ' ' + json.errors.join(' ') : ' Dedicated accounts are ready. Review and save the mapping.'))
    } catch (e) { setStatus(e instanceof Error ? e.message : 'Request failed.') } finally { setBusy(false) }
  }

  async function createAccount() {
    if (!newAccount) return
    setBusy(true); setStatus(null)
    try {
      const { ok, json } = await post('/api/accounting/chart', { ...newAccount, action: 'add' })
      if (!ok) { setStatus(json?.error ?? 'Could not create account.'); return }
      setChart(c => [...c, { code: json.code, name: json.name }].sort((a, b) => a.code.localeCompare(b.code)))
      setMapping(m => ({ ...m, [newAccount.qbAccount]: json.code }))
      setMappingSaved(false); setDryRun(null); setTieOut(null); setNewAccount(null)
      setStatus(`Created ${json.code} — ${json.name} on ${group} and selected it. Save the mapping when ready.`)
    } catch (e) { setStatus(e instanceof Error ? e.message : 'Could not create account.') }
    finally { setBusy(false) }
  }

  function changeMapping(account: string, code: string) {
    setMapping(m => ({ ...m, [account]: code }))
    setMappingSaved(false); setDryRun(null); setTieOut(null)
  }

  async function runImport(isDry: boolean) {
    setBusy(true); setStatus(null)
    try {
      const { ok, json } = await post('/api/accounting/quickbooks/import', {
        text: journalText, dryRun: isDry, reviewToken: importReview?.token,
      })
      setImportReview(json.importReview ?? null)
      if (!ok) { setStatus(json?.error ?? 'Import failed.'); return }
      setCapitalWarnings(json.capitalWarnings ?? [])
      setMatches({ duplicates: json.duplicates ?? [], recovered: json.recovered ?? [] })
      if (isDry) { setDryRun(json); return }
      setDryRun(null)
      setStatus(`Created ${json.created} draft entr${json.created === 1 ? 'y' : 'ies'}; ${json.alreadyPresent} already present; ${json.skipped} skipped.`)
      await loadRuns()
    } catch (e) { setStatus(e instanceof Error ? e.message : 'Request failed.') } finally { setBusy(false) }
  }

  async function runTieOut() {
    setBusy(true); setStatus(null)
    try {
      const { ok, json } = await post('/api/accounting/quickbooks/tie-out', { text: tbText, asOf: tbAsOf })
      if (!ok) { setStatus(json?.error ?? 'Could not tie out.'); return }
      setTieOut(json)
    } catch (e) { setStatus(e instanceof Error ? e.message : 'Request failed.') } finally { setBusy(false) }
  }

  const coverage = parsed
    ? `${Object.values(mapping).filter(c => c && c !== '__exclude__').length} of ${parsed.accounts.length} accounts mapped`
    : null

  const pendingHoldings = parsed?.discoveredHoldings.filter(name => parsed.accounts.some(a =>
    a.suggestsHolding === name && (!mapping[a.qbAccount] || mapping[a.qbAccount] === '1100'))) ?? []
  const unresolved = parsed?.accounts.filter(a => !mapping[a.qbAccount]).length ?? 0

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">Importing into <strong>{group}</strong>. Accounts and mappings belong to this entity.</p>
      {status && <p role="status" className="text-sm text-warning">{status}</p>}

      {/* ---- Step 1 -------------------------------------------------------- */}
      <Card className="rounded-card">
        <CardContent className="p-4 space-y-3">
          <h2 className="text-base font-medium">1 · Paste the QuickBooks Journal export</h2>
          <p className="text-sm text-muted-foreground">
            Reports → Journal → export to CSV or Excel, then paste it here. The Journal is the
            only QuickBooks report that is already double-entry; the General Ledger loses the
            transaction grouping and the Trial Balance has no detail.
          </p>
          <Textarea rows={6} disabled={busy} value={journalText} onChange={e => { setJournalText(e.target.value); setParsed(null); setMappingSaved(false); setDryRun(null); setTieOut(null) }}
                    placeholder="Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit"
                    className="font-mono text-xs" />
          <Button size="sm" onClick={runParse} disabled={busy || !journalText.trim()}>
            {busy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Parse
          </Button>

          {parsed && (
            <div className="space-y-2 pt-2 text-sm">
              <p>
                <CheckCircle2 className="inline h-4 w-4 mr-1 text-success" />
                {parsed.transactionCount} transaction(s)
                {parsed.dateRange && <> from {parsed.dateRange.first} to {parsed.dateRange.last}</>},
                {' '}{parsed.accounts.length} distinct account(s).
              </p>
              {parsed.errors.length > 0 && (
                <div>
                  <p className="text-warning">
                    <AlertTriangle className="inline h-4 w-4 mr-1" />
                    {parsed.errors.length} row-level problem(s) — these were NOT imported:
                  </p>
                  <ul className="list-disc pl-5 text-destructive">
                    {parsed.errors.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---- Step 2 -------------------------------------------------------- */}
      {parsed && (
        <Card className="rounded-card">
          <CardContent className="p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-medium">2 · Map the accounts</h2>
              {mappingSaved && (
                <Button ref={mappingToggle} size="sm" variant="outline"
                  aria-expanded={mappingExpanded} aria-controls="quickbooks-account-mapping"
                  onClick={() => setMappingExpanded(open => !open)}>
                  {mappingExpanded ? 'Hide mapping' : 'Review / edit mapping'}
                </Button>
              )}
            </div>
            {mappingSaved && (
              <p role="status" className="flex items-center gap-2 text-sm text-success">
                <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
                Mapping saved · {Object.values(mapping).filter(c => c && c !== '__exclude__').length} mapped
                {' · '}{Object.values(mapping).filter(c => c === '__exclude__').length} excluded. Ready to import.
              </p>
            )}
            <div id="quickbooks-account-mapping" hidden={mappingSaved && !mappingExpanded}>
            <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Busiest accounts first. Choose an existing account or create one here. Exclusion is an explicit choice and drops every transaction touching that account. {coverage}; {unresolved} need a decision.
            </p>

            {pendingHoldings.length > 0 && (
              <details className="rounded-lg border p-3" open>
                <summary className="cursor-pointer text-sm font-medium">Review {pendingHoldings.length} investment holdings</summary>
                <div className="flex flex-col gap-3 pt-3">
                  <p className="text-sm text-muted-foreground">
                    For each name, this creates a portfolio record if missing and dedicated investment accounts on {group}.
                    Existing records are reused without changing their type. New fund records start with a $0 commitment for you to complete later.
                    This does not import transactions, set balances, or record capital calls. Review the account mapping afterward.
                  </p>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setHoldingTypes(Object.fromEntries(pendingHoldings.map(name => [name, 'fund'])))}>Set all to fund</Button>
                  {pendingHoldings.map(name => (
                    <div key={name} className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm">{name}</span>
                      <select aria-label={`Holding type for ${name}`} value={holdingTypes[name] ?? ''} disabled={busy}
                        onChange={e => setHoldingTypes(t => ({ ...t, [name]: e.target.value }))}
                        className="border rounded-lg px-2 py-1 text-sm bg-background">
                        <option value="">Choose type if new</option>
                        <option value="fund">Fund</option>
                        <option value="company">Company / direct investment</option>
                      </select>
                    </div>
                  ))}
                  <Button size="sm" variant="outline" onClick={discoverHoldings}
                    disabled={busy || pendingHoldings.some(name => !holdingTypes[name])}>
                    Create or link holdings and investment accounts
                  </Button>
                </div>
              </details>
            )}

            {newAccount && (
              <fieldset disabled={busy} className="flex flex-col gap-3 rounded-lg border p-3">
                <legend className="px-1 text-sm font-medium">New account for {newAccount.qbAccount}</legend>
                <p className="text-sm text-muted-foreground">Suggested from the QuickBooks name. Review the number and type before creating it on {group}.</p>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="new-account-code">Account number</FieldLabel>
                    <Input autoFocus id="new-account-code" value={newAccount.code} maxLength={20} onChange={e => setNewAccount({ ...newAccount, code: e.target.value })} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="new-account-name">Account name</FieldLabel>
                    <Input id="new-account-name" value={newAccount.name} onChange={e => setNewAccount({ ...newAccount, name: e.target.value })} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="new-account-type">Account type</FieldLabel>
                    <select id="new-account-type" value={newAccount.type} className="border rounded-lg px-2 py-1 text-sm bg-background"
                    onChange={e => setNewAccount({ ...newAccount, type: e.target.value as AccountSuggestion['type'], subtype: null })}>
                    {['asset', 'liability', 'equity', 'income', 'expense'].map(type => <option key={type} value={type}>{type}</option>)}
                    </select>
                  </Field>
                </FieldGroup>
                <div className="flex gap-2">
                  <Button size="sm" onClick={createAccount} disabled={busy || !newAccount.name.trim() || !newAccount.code.trim()}>Create and select account</Button>
                  <Button size="sm" variant="outline" onClick={() => setNewAccount(null)}>Cancel</Button>
                </div>
              </fieldset>
            )}

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>QuickBooks account</TableHead>
                  <TableHead className="text-right">Lines</TableHead>
                  <TableHead>Maps to</TableHead>
                  <TableHead>Why</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {parsed.accounts.map(a => (
                  <TableRow key={a.qbAccount}>
                    <TableCell className="font-medium">{a.qbAccount}</TableCell>
                    <TableCell className="text-right tabular-nums">{a.lineCount}</TableCell>
                    <TableCell>
                      <select
                        value={mapping[a.qbAccount] ?? ''}
                        aria-label={`Account for ${a.qbAccount}`}
                        disabled={busy}
                        onChange={e => changeMapping(a.qbAccount, e.target.value)}
                        className="border rounded-lg px-2 py-1 text-sm"
                      >
                        <option value="">Choose or create an account</option>
                        <option value="__exclude__">Exclude from import (skip affected transactions)</option>
                        {chart.map(c => (
                          <option key={c.code} value={c.code}>{c.code} — {c.name}</option>
                        ))}
                      </select>
                      {!a.suggestsHolding && <Button size="sm" variant="outline" disabled={busy} className="mt-2"
                        onClick={() => setNewAccount({ ...suggestAccount(a.qbAccount, chart), qbAccount: a.qbAccount })}>
                        Create account…
                      </Button>}
                    </TableCell>
                    <TableCell className={`text-sm ${a.confidence === 'none' ? 'text-warning' : 'text-muted-foreground'}`}>
                      {mapping[a.qbAccount] && mapping[a.qbAccount] !== '__exclude__' && mapping[a.qbAccount] !== a.code
                        ? 'Selected for this import.' : a.reason}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <Button size="sm" onClick={saveMapping} disabled={busy || unresolved > 0}>Save mapping</Button>
            </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ---- Step 3 -------------------------------------------------------- */}
      {parsed && (
        <Card className="rounded-card">
          <CardContent className="p-4 space-y-3">
            <h2 className="text-base font-medium">3 · Import</h2>
            <p className="text-sm text-muted-foreground">
              Every entry imports as a DRAFT and is posted from the journal page. Re-running is
              safe — entries already imported are matched by their content hash, not duplicated.
            </p>
            {!mappingSaved && <p className="text-sm text-muted-foreground">Resolve every account and save the mapping to enable import.</p>}
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => runImport(true)} disabled={busy || !mappingSaved}>Review import</Button>
              <Button size="sm" onClick={() => runImport(false)} disabled={busy || !mappingSaved}>Import as drafts</Button>
            </div>

            {dryRun && (
              <p className="text-sm">
                Would create {dryRun.wouldCreate}; {dryRun.alreadyPresent} already present;
                {' '}{dryRun.skipped} skipped.
              </p>
            )}

            {matches.recovered.length > 0 && (
              <details className="rounded border border-warning p-3 text-sm">
                <summary>{matches.recovered.length} transactions an earlier import skipped as duplicates</summary>
                <p className="my-2 text-muted-foreground">They share a date, accounts and amounts with an entry already imported, and differ only in payee or memo. Earlier imports did not compare payees; these are the ones missing from the book.</p>
                <ul className="max-h-64 overflow-y-auto space-y-1">
                  {matches.recovered.map((m, index) => <li key={index}>{m.entryDate} {m.memo ?? ''} — {m.reason}</li>)}
                </ul>
              </details>
            )}

            {matches.duplicates.length > 0 && (
              <details className="rounded border p-3 text-sm">
                <summary>{matches.duplicates.length} already present — why each was matched</summary>
                <ul className="mt-2 max-h-64 overflow-y-auto space-y-1">
                  {matches.duplicates.map((m, index) => <li key={index}>{m.entryDate} {m.memo ?? ''} — {m.reason}</li>)}
                </ul>
              </details>
            )}

            <ImportReviewPanel review={importReview} />

            {capitalWarnings.length > 0 && (
              <details className="rounded border border-warning p-3 text-sm">
                <summary>{capitalWarnings.length} capital lines need an LP match</summary>
                <p className="my-2 text-muted-foreground">These amounts remain in unallocated capital. Review the named counterparty or bank evidence before assigning an LP.</p>
                <ul className="max-h-64 overflow-y-auto space-y-1">
                  {capitalWarnings.map((warning, index) => <li key={index}>{warning}</li>)}
                </ul>
              </details>
            )}

            {runs.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Run</TableHead>
                    <TableHead className="text-right">Parsed</TableHead>
                    <TableHead className="text-right">Created</TableHead>
                    <TableHead className="text-right">Matched</TableHead>
                    <TableHead className="text-right">Skipped</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map(r => (
                    <TableRow key={r.id}>
                      <TableCell className="tabular-nums text-xs">{String(r.created_at).slice(0, 19).replace('T', ' ')}{r.reconciliation_review && <details className="mt-2"><summary className="cursor-pointer">Import comparison</summary><ImportReviewPanel review={r.reconciliation_review} /></details>}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.transactions_parsed}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.entries_created}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.entries_matched}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.transactions_skipped}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {/* ---- Step 4 -------------------------------------------------------- */}
      <Card className="rounded-card">
        <CardContent className="p-4 space-y-3">
          <h2 className="text-base font-medium">4 · Tie out to QuickBooks</h2>
          <p className="text-sm text-muted-foreground">
            Paste the QuickBooks trial balance for a period end. The migration is done when
            every period ties — not when the import runs without errors. Repeat per period.
          </p>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">As of</span>
            <input type="date" value={tbAsOf} onChange={e => setTbAsOf(e.target.value)}
                   className="border rounded-lg px-2 py-1 text-sm" />
          </div>
          <Textarea rows={5} value={tbText} onChange={e => setTbText(e.target.value)}
                    placeholder="Account,Debit,Credit" className="font-mono text-xs" />
          <Button size="sm" onClick={runTieOut} disabled={busy || !tbText.trim() || !tbAsOf}>
            Compare
          </Button>

          {tieOut && (
            <div className="space-y-2 pt-2">
              {!tieOut.ties && !!tieOut.openingEntries?.length && (
                <div className="flex flex-col gap-2 text-sm">
                  <p className="text-warning">
                    This comparison also includes {tieOut.openingEntries.length} opening-balance entry/entries.
                    Full QuickBooks history may overlap with these starting balances.
                    {tieOut.quickBooksOnly?.ties && ' The imported QuickBooks entries alone match every mapped trial-balance account; the full ledger still differs.'}
                  </p>
                  {tieOut.openingEntries.map(entry => (
                    <p key={entry.id}>
                      {entry.date} · {entry.memo || 'Opening balance'} · {entry.status} · Cash {fmt(entry.cash)}.
                    </p>
                  ))}
                  <p className="text-muted-foreground">Review overlapping opening entries in the Journal before changing them. No entries have been removed from this comparison.</p>
                </div>
              )}
              {tieOut.ties ? (
                <p className="text-sm text-success">
                  <CheckCircle2 className="inline h-4 w-4 mr-1" />
                  Every mapped account ties at {tieOut.asOf}.
                </p>
              ) : (
                <>
                  <p className="text-sm text-warning">
                    <AlertTriangle className="inline h-4 w-4 mr-1" />
                    {tieOut.lines.length} account(s) differ at {tieOut.asOf}.
                  </p>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Code</TableHead>
                        <TableHead>Account</TableHead>
                        <TableHead className="text-right">Ours</TableHead>
                        <TableHead className="text-right">QuickBooks</TableHead>
                        <TableHead className="text-right">Difference</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {tieOut.lines.map(l => (
                        <TableRow key={l.code}>
                          <TableCell className="tabular-nums">{l.code}</TableCell>
                          <TableCell>{l.name}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmt(l.ours)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmt(l.theirs)}</TableCell>
                          <TableCell className="text-right tabular-nums text-warning">{fmt(l.difference)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </>
              )}
              <p className="text-xs text-muted-foreground">
                Both columns use debit minus credit, so credit balances appear negative.{' '}
                Includes draft entries, since imported entries stay drafts until they are
                reviewed and posted.
                {tieOut.unmappedAccounts.length > 0 && (
                  <> {tieOut.unmappedAccounts.length} QuickBooks account(s) are unmapped and were
                  excluded from the comparison: {tieOut.unmappedAccounts.join(', ')}.</>
                )}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-card border-warning">
        <CardContent className="p-4 space-y-2">
          <h2 className="text-base font-medium">Before you call it done</h2>
          <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1">
            <li>
              <strong>Set the ledger start date</strong> on the vehicle to the day after the last
              tied period. Register events before it are memo-only and post nothing, because
              QuickBooks already posted them.
            </li>
            <li>
              <strong>Attribute LP capital per partner.</strong> QuickBooks carries partners&rsquo;
              capital pooled, so per-LP history has to come from the spreadsheet. Capital left on
              the pooled account balances perfectly while every LP shows zero — the close blocks
              on this, and it is the failure this migration produces if the step is skipped.
            </li>
            <li><strong>Post the drafts</strong> from the journal page once the tie-out is green.</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
