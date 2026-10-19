'use client'

import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { HeaderTable, ShellSection } from './parts'
import { EmptyState } from '@/components/ui/empty-state'

// ── GPU fleet (P5) ── One server: what it is, how it depreciates, where it is listed, what it earned
// and how busy it was each month, what happened to it, and its paperwork. Wired in P5-2 and P5-4.

export function AssetDetail({ vehicleId }: { vehicle: string; vehicleId: string | null; assetId: string }) {
  return (
    <div className="space-y-4">
      {vehicleId && (
        <Link href={`/funds/${vehicleId}/fleet`} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" />Fleet register
        </Link>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <ShellSection title="Specs" description="Type, GPU count, serial numbers and the datacenter it sits in.">
          <EmptyState compact>The asset&rsquo;s specs appear once the asset model ships.</EmptyState>
        </ShellSection>
        <ShellSection title="Depreciation schedule" description="Cost, salvage value, useful life, and net book value month by month.">
          <HeaderTable columns={[{ label: 'Month' }, { label: 'Depreciation', align: 'right' }, { label: 'Accumulated', align: 'right' }, { label: 'NBV', align: 'right' }]}>
            No schedule yet. It is drawn from the asset&rsquo;s cost and in-service date.
          </HeaderTable>
        </ShellSection>
      </div>

      <ShellSection title="Listings" description="Where the server is offered for rent, and at what rate.">
        <EmptyState compact>No listings yet.</EmptyState>
      </ShellSection>

      <ShellSection title="Monthly revenue & utilization" description="Entered per period on the Revenue & payouts page.">
        <HeaderTable columns={[
          { label: 'Month' }, { label: 'GPU-hours rented', align: 'right' }, { label: 'Utilization', align: 'right' },
          { label: 'Gross revenue', align: 'right' }, { label: '$/GPU-hour', align: 'right' }, { label: 'Downtime hours', align: 'right' },
        ]}>
          No periods entered for this asset yet.
        </HeaderTable>
      </ShellSection>

      <div className="grid gap-4 lg:grid-cols-2">
        <ShellSection title="Events" description="Purchase, installation, downtime, repairs and disposal.">
          <EmptyState compact>No events recorded yet.</EmptyState>
        </ShellSection>
        <ShellSection title="Documents" description="Invoices, shipping, warranty and datacenter paperwork.">
          <EmptyState compact>No documents attached yet.</EmptyState>
        </ShellSection>
      </div>
    </div>
  )
}
