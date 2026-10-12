'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Loader2, Check, AlertTriangle } from 'lucide-react'
import { useCurrency, formatCurrencyFull } from '@/components/currency-context'
import { AccountingPageHeader, AccountingBody } from '@/components/accounting-chrome'
import { FirmOverview } from '../../firm-overview'
import type { FirmEntity } from '@/lib/accounting/firm-entities'
import type { IntercompanyPair } from '@/lib/accounting/intercompany-firm'

// The family page's body: the Financials overview scoped to one entity group, then who in the
// family owes whom. See app/(app)/funds/group/[groupId]/page.tsx.

interface Family { group: { id: string; name: string }; members: FirmEntity[]; intercompany: IntercompanyPair[] }

export function FamilyView({ groupId }: { groupId: string }) {
  const currency = useCurrency()
  const money = (n: number) => formatCurrencyFull(n, currency)
  const [data, setData] = useState<Family | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    fetch(`/api/accounting/firm/family?groupId=${encodeURIComponent(groupId)}`)
      .then(async r => {
        const body = await r.json().catch(() => null)
        if (!r.ok) throw new Error(r.status === 404 ? 'This entity group does not exist, or none of its entities are yours to see.' : body?.error ?? 'Could not load the group.')
        return body as Family
      })
      .then(d => { if (live) setData(d) })
      .catch(e => { if (live) setError((e as Error).message) })
    return () => { live = false }
  }, [groupId])

  const only = useMemo(() => data?.members.map(m => m.id) ?? [], [data])
  const names = useMemo(() => new Map((data?.members ?? []).map(m => [m.id, m.name])), [data])

  if (error) return <p className="text-sm text-destructive">{error}</p>
  if (!data) return <div className="p-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>

  const mismatched = data.intercompany.filter(p => p.ties === false).length

  return (
    <>
      <AccountingPageHeader title={data.group.name}>
        {data.members.length} {data.members.length === 1 ? 'entity' : 'entities'} in this group: what they hold, what is waiting
        on their books, and what they owe each other.
      </AccountingPageHeader>
      <AccountingBody>
        <div className="space-y-8">
          <FirmOverview only={only} />

          <section className="space-y-2">
            <h2 className="text-base font-medium">Intercompany balances</h2>
            {data.intercompany.length === 0 ? (
              <p className="text-sm text-muted-foreground">No balances outstanding between these entities.</p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  Each balance read from both entities&rsquo; ledgers. Where they disagree, one side is missing an entry.
                  {mismatched > 0 && <span className="text-warning"> {mismatched} {mismatched === 1 ? 'balance does' : 'balances do'} not agree.</span>}
                </p>
                <div className="overflow-x-auto rounded-card border">
                  <table className="w-full text-sm">
                    <thead className="text-xs text-muted-foreground bg-muted/40">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium">Between</th>
                        <th className="text-right px-3 py-2 font-medium">Per the first&rsquo;s books</th>
                        <th className="text-right px-3 py-2 font-medium">Per the second&rsquo;s books</th>
                        <th className="text-left px-3 py-2 font-medium">Agrees</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.intercompany.map(p => {
                        const a = names.get(p.vehicleId) ?? '—'
                        const b = names.get(p.counterpartyVehicleId) ?? p.counterpartyName
                        // Positive net: the first entity is owed. Said in words, because a signed
                        // number across two entities is exactly where direction gets lost.
                        const who = p.net >= 0 ? `${b} owes ${a}` : `${a} owes ${b}`
                        return (
                          <tr key={`${p.vehicleId}-${p.counterpartyVehicleId}`} className="border-t">
                            <td className="px-3 py-2">
                              <Link href={`/funds/${p.vehicleId}/ledger`} className="hover:underline">{a}</Link>
                              <span className="text-muted-foreground"> and </span>
                              {names.has(p.counterpartyVehicleId)
                                ? <Link href={`/funds/${p.counterpartyVehicleId}/ledger`} className="hover:underline">{b}</Link>
                                : <span>{b}</span>}
                              <span className="block text-xs text-muted-foreground">{who}</span>
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">{money(Math.abs(p.net))}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{p.counterpartyNet == null ? <span className="text-muted-foreground">Outside the group</span> : money(Math.abs(p.counterpartyNet))}</td>
                            <td className="px-3 py-2">
                              {p.ties == null
                                ? <span className="text-muted-foreground">&mdash;</span>
                                : p.ties
                                  ? <span className="inline-flex items-center gap-1 text-success"><Check className="h-3.5 w-3.5" />Yes</span>
                                  : <span className="inline-flex items-center gap-1 text-warning"><AlertTriangle className="h-3.5 w-3.5" />Off by {money(Math.abs((p.counterpartyNet ?? 0) - p.net))}</span>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        </div>
      </AccountingBody>
    </>
  )
}
