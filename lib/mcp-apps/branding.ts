// The fund's look for a dashboard: shared by the fund's connector (lib/agent/dashboard-tools.ts)
// and the investor connector (lib/portal/mcp-tools.ts), so both draw in the fund's own colours.

import type { SupabaseClient } from '@supabase/supabase-js'
import { themeCssVars, type FundTheme } from '@/lib/theme'
import type { DashboardBranding } from './payload'

/**
 * The fund's name, reporting currency and theme. One query each, in parallel; a failure of
 * either degrades to the defaults rather than failing a dashboard over its heading.
 */
export async function loadBranding(admin: SupabaseClient, fundId: string): Promise<DashboardBranding> {
  const [fund, settings] = await Promise.all([
    (admin as any).from('funds').select('name').eq('id', fundId).maybeSingle(),
    (admin as any).from('fund_settings').select('currency, theme').eq('fund_id', fundId).maybeSingle(),
  ])
  const currency = typeof settings?.data?.currency === 'string' && /^[A-Za-z]{3}$/.test(settings.data.currency)
    ? settings.data.currency.toUpperCase()
    : 'USD'
  return {
    fundName: typeof fund?.data?.name === 'string' ? fund.data.name : null,
    currency,
    // themeCssVars validates every value it emits (lib/theme.ts); the view checks the shape again.
    cssVars: themeCssVars((settings?.data?.theme as FundTheme | null) ?? null),
  }
}
