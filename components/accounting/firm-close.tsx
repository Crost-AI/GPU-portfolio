'use client'

import { Fragment, useEffect, useState } from 'react'
import Link from 'next/link'
import { Loader2, Check, AlertTriangle, Circle, RotateCcw } from 'lucide-react'
import { useVehicleGroups, GroupHeadingRow } from '@/components/vehicle-groups'
import { groupBySection, isGrouped } from '@/lib/vehicle-groups'
import { EmptyState } from '@/components/ui/empty-state'
import { quarterLabel, CLOSE_GRACE_DAYS } from '@/lib/accounting/attention'
import type { CloseCell, CloseGrid, CloseGridRow } from '@/lib/accounting/close-grid'

// THE /funds/periods LANDING: the close calendar. Entities down, the last eight quarter-ends
// across, each cell closed or not — so the quarter that is behind, and where, is visible at a
// glance instead of read off a "closed through" date per row. A cell links to that entity's Close
// page, which is where a period is closed or reopened.

const CELL: Record<CloseCell, { label: string; cls: string; icon: React.ReactNode }> = {
  closed: { label: 'Closed', cls: 'bg-success-subtle text-success', icon: <Check className="h-3.5 w-3.5" /> },
  reopened: { label: 'Reopened', cls: 'bg-warning-subtle text-warning', icon: <RotateCcw className="h-3.5 w-3.5" /> },
  late: { label: 'Not closed', cls: 'bg-warning-subtle text-warning', icon: <AlertTriangle className="h-3.5 w-3.5" /> },
  due: { label: 'Due', cls: 'text-muted-foreground', icon: <Circle className="h-3 w-3" /> },
  none: { label: 'No books yet', cls: '', icon: null },
}

export function FirmCloseView() {
  const vehicleGroups = useVehicleGroups()
  const [data, setData] = useState<CloseGrid | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    fetch('/api/accounting/firm/periods')
      .then(async r => {
        const body = await r.json().catch(() => null)
        if (!r.ok) throw new Error(body?.error ?? 'Could not load the close calendar.')
        return body as CloseGrid
      })
      .then(d => { if (live) setData(d) })
      .catch(e => { if (live) setError((e as Error).message) })
    return () => { live = false }
  }, [])

  if (error) return <p className="text-sm text-destructive">{error}</p>
  if (!data) return <div className="p-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
  if (data.rows.length === 0) return <EmptyState>No entities yet. Add one on Admin to start keeping its books.</EmptyState>

  const late = data.rows.filter(r => r.cells.some(c => c === 'late' || c === 'reopened'))
  const sections = groupBySection(data.rows, vehicleGroups, r => ({ id: r.id, name: r.name }))
  const grouped = isGrouped(sections, vehicleGroups)
  const cols = data.quarters.length + 1

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {late.length === 0
          ? `Every quarter through ${quarterLabel(data.expected)} is closed wherever there are books to close.`
          : `${late.length} ${late.length === 1 ? 'entity has' : 'entities have'} a quarter through ${quarterLabel(data.expected)} that is not closed.`}
        {' '}A quarter is due once it ends and late {CLOSE_GRACE_DAYS} days after.
        {data.mancoOmitted && ' Management companies are not shown; that needs the management-company grant.'}
      </p>

      <div className="overflow-x-auto rounded-card border">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground bg-muted/40">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Entity</th>
              {data.quarters.map(q => (
                <th key={q} className="px-2 py-2 font-medium text-center whitespace-nowrap">{quarterLabel(q)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sections.map(sec => (
              <Fragment key={sec.group?.id ?? 'other'}>
                {grouped && <GroupHeadingRow label={sec.label} count={sec.items.length} colSpan={cols} />}
                {sec.items.map(r => <Row key={r.id} row={r} quarters={data.quarters} />)}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        {(['closed', 'late', 'reopened', 'due'] as CloseCell[]).map(c => (
          <span key={c} className="inline-flex items-center gap-1.5">
            <span className={`inline-flex h-5 w-5 items-center justify-center rounded-sm ${CELL[c].cls}`}>{CELL[c].icon}</span>
            {CELL[c].label}
          </span>
        ))}
      </div>
    </div>
  )
}

function Row({ row, quarters }: { row: CloseGridRow; quarters: string[] }) {
  const href = `/funds/${row.id}/periods`
  return (
    <tr className="border-t hover:bg-muted/30">
      <td className="px-3 py-1.5 font-medium whitespace-nowrap">
        <Link href={href} className="hover:underline">{row.name}</Link>
      </td>
      {row.cells.map((c, i) => (
        <td key={quarters[i]} className="px-2 py-1.5 text-center">
          {c === 'none' ? (
            <span className="text-muted-foreground" aria-label={`${quarterLabel(quarters[i])}: ${CELL[c].label}`}>&middot;</span>
          ) : (
            <Link
              href={href}
              title={`${quarterLabel(quarters[i])}: ${CELL[c].label}`}
              className={`inline-flex h-6 w-6 items-center justify-center rounded-sm ${CELL[c].cls}`}
            >
              {CELL[c].icon}
              <span className="sr-only">{CELL[c].label}</span>
            </Link>
          )}
        </td>
      ))}
    </tr>
  )
}
