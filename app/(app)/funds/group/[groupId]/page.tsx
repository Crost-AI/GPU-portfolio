import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { requireAccountingAccess } from '../../guard'
import { FamilyView } from './family-view'

export const metadata: Metadata = { title: 'Entity group' }

/**
 * THE FAMILY PAGE: one entity group (Settings → Entity groups) — typically a fund, its GP and the
 * management company that serves it — on one page. The Financials overview scoped to the group,
 * plus what its members owe each other, read from both sides' books so a one-sided entry shows.
 *
 * Renders no fund data on the server: the group, its members and the balances all arrive through
 * /api/accounting/firm/family, which the middleware gates and which narrows to what the caller may
 * see. The gate here is the section's, so a member without accounting never reaches the page.
 */
export default async function FamilyPage(props: { params: Promise<{ groupId: string }> }) {
  await requireAccountingAccess()
  const { groupId } = await props.params
  return (
    <div className="pt-4 md:pt-8 pb-8 w-full">
      <Link href="/funds" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="h-3.5 w-3.5" />All entities
      </Link>
      <FamilyView groupId={groupId} />
    </div>
  )
}
