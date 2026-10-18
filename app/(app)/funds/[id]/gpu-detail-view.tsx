'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { useVehicle, FundSwitcher } from '@/components/accounting-vehicle'
import { AccountingBody, AccountingPageHeader } from '@/components/accounting-chrome'
import { Metric } from '@/components/ui/metric'
import { useAccess, useIsAdmin } from '@/components/access-context'
import { canSee } from '@/components/app-sidebar'
import { ACCOUNTING_SECTIONS } from '@/lib/accounting/nav'
import { VEHICLE_KIND_LABELS } from '@/lib/vehicle-kinds'

// ── GPU fleet (P5) ── The GPU SPV's lead page, in place of a fund's performance lead: what the fleet
// is worth, what it earned, how busy it was, and how much of the investors' capital is still out.
// Each figure is a dash until the PR that computes it lands; the caption names which one.

// The four GPU sections, straight from the nav, so the quick links and the subnav cannot disagree.
const GPU_SECTIONS = ACCOUNTING_SECTIONS.filter(s => s.showFor?.includes('gpu_spv'))

export function GpuDetailView({
  vehicle, vehicleId, active,
}: {
  vehicle: string
  vehicleId: string
  active: boolean
}) {
  const { setVehicle } = useVehicle()
  const access = useAccess()
  const isAdmin = useIsAdmin()

  // Pin the section's vehicle context to this URL, exactly as the management company page does. It
  // is what tells the sidebar this entity's KIND, and the subnav's GPU sections are built from it.
  useEffect(() => { setVehicle(vehicle, vehicleId) }, [vehicle, vehicleId, setVehicle])

  // Only the sections this caller can open: Fleet and Revenue need the fleet grant, the waterfall
  // needs investors' capital, Scenarios the books this page already required. A link that bounces
  // to the dashboard is worse than no link.
  const links = GPU_SECTIONS.filter(s => canSee({ domain: s.domain, featureKey: s.feature }, isAdmin, access))

  return (
    <>
      <AccountingPageHeader
        title={<span className="flex min-w-0 items-center gap-2"><span className="truncate">{vehicle}</span>
          <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-caption font-normal text-muted-foreground">{VEHICLE_KIND_LABELS.gpu_spv}</span>
          {!active && (
            <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-caption font-normal text-muted-foreground">Inactive</span>
          )}
        </span>}
        titleAttr={vehicle}
        actions={<FundSwitcher />}
      >
        GPU SPV &mdash; the fleet&rsquo;s book value, rental revenue and utilization, and the
        investors&rsquo; capital still to be returned.
      </AccountingPageHeader>

      <AccountingBody>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric label="Fleet NBV" value="—" sub="Fills in with the fleet register (P5-2)" />
            <Metric label="LTM revenue" value="—" sub="Fills in with revenue entry (P5-4)" />
            <Metric label="Utilization" value="—" sub="Fills in with revenue entry (P5-4)" />
            <Metric label="Unreturned capital" value="—" sub="Fills in with the waterfall (P5-3)" />
          </div>

          {links.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {links.map(s => {
                const Icon = s.icon
                return (
                  <Link
                    key={s.href}
                    href={`/funds/${vehicleId}/${s.href.slice('/funds/'.length)}`}
                    className="group rounded-card border bg-card p-4 shadow-sm transition-colors hover:bg-muted/30 dark:shadow-none"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2 font-medium group-hover:underline">
                        <Icon className="h-4 w-4 text-muted-foreground" />{s.label}
                      </span>
                      <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
                    </div>
                    <p className="mt-1.5 text-xs text-muted-foreground">{s.desc}</p>
                  </Link>
                )
              })}
            </div>
          )}
        </div>
      </AccountingBody>
    </>
  )
}
