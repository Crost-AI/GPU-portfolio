'use client'

import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useVehicle } from '@/components/accounting-vehicle'

/**
 * The call or distribution with the fields of the ILPA Capital Call & Distribution Template, one sheet
 * per partner. A download only: it restates the notice register and sends nothing.
 */
export function IlpaDownload({ kind, id }: { kind: 'capital_call' | 'distribution'; id: string }) {
  const { group } = useVehicle()
  const qs = new URLSearchParams({ kind, id, format: 'xlsx', ...(group ? { group } : {}) })
  return (
    <Button size="sm" variant="outline" asChild className="gap-1.5" title="The data for the ILPA Capital Call & Distribution Template (v. 2.0), one sheet per partner">
      <a href={`/api/accounting/notices/ilpa?${qs.toString()}`}><Download className="h-3.5 w-3.5" />ILPA file (.xlsx)</a>
    </Button>
  )
}
