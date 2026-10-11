import { createClient } from '@/lib/supabase/server'
import { CompanyCountProvider } from './setup-stage'

/**
 * One head-only count for /start: does the fund hold any companies yet? A new fund's Start page
 * otherwise suggests questions nobody can answer ("How is the portfolio doing this quarter?").
 *
 * Read with the caller's OWN client, so RLS ("companies read needs portfolio") decides what they
 * may count — a member without the portfolio domain gets 0 here, and the page only treats 0 as
 * "empty" when the resolver says they can read portfolio (isSetupStage). No rows, only a count,
 * and only for the caller's own fund.
 */
export default async function StartLayout({ children }: { children: React.ReactNode }) {
  let count: number | null = null
  try {
    const supabase = await createClient()
    // Every holding, fund holdings included: a fund-of-funds with only fund positions is not empty.
    const { count: n, error } = await supabase.from('companies').select('id', { count: 'exact', head: true })
      .in('holding_type', ['company', 'fund'])
    count = error ? null : (n ?? 0)
  } catch {
    count = null
  }
  return <CompanyCountProvider count={count}>{children}</CompanyCountProvider>
}
