import { redirect } from 'next/navigation'

/**
 * Portfolio construction is the Forecast page's Portfolio tab now (plans/plan-unified-plan.md §5).
 * This keeps the old URL working and renders nothing itself, so it needs no gate: the Forecast page
 * it lands on gates the vehicle.
 */
export default async function ConstructionRedirect(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  redirect(`/funds/${id}/forecast?tab=investments`)
}
