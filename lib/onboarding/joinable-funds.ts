import type { SupabaseClient } from '@supabase/supabase-js'
import { claimableEmailDomain } from './wizard'

export interface JoinableFund {
  id: string
  name: string
}

/**
 * The funds a user with no fund yet may ask to join, best match first.
 *
 *   1. A fund that lists the user's exact address on its signup allow-list.
 *   2. A fund that lists the user's whole domain (`*@domain`) on its allow-list.
 *   3. A fund whose `email_domain` is the user's domain.
 *
 * Domains only count when they are claimable: a consumer mailbox domain (gmail.com …) says nothing
 * about who someone works for, so neither `*@gmail.com` on a list nor a fund that once claimed
 * gmail.com matches. An exact address does, whatever its domain — that is how an admin lets in
 * specific people. Matching only offers a join REQUEST; an admin still approves it.
 */
export async function joinableFunds(
  admin: SupabaseClient<any, any, any>,
  rawEmail: string | null | undefined,
): Promise<JoinableFund[]> {
  const email = rawEmail?.trim().toLowerCase()
  if (!email || !email.includes('@')) return []
  const domain = claimableEmailDomain(email)
  const wildcard = domain ? `*@${domain}` : null

  const { data: listed } = await admin
    .from('allowed_signups')
    .select('fund_id, email_pattern')
    .in('email_pattern', wildcard ? [email, wildcard] : [email])
    .not('fund_id', 'is', null)

  const rows = ((listed as { fund_id: string; email_pattern: string }[] | null) ?? [])
  const ordered: string[] = []
  for (const pattern of [email, wildcard]) {
    for (const r of rows) if (r.email_pattern === pattern && !ordered.includes(r.fund_id)) ordered.push(r.fund_id)
  }

  const names = new Map<string, string>()
  if (ordered.length > 0) {
    const { data } = await admin.from('funds').select('id, name').in('id', ordered)
    for (const f of (data as JoinableFund[] | null) ?? []) names.set(f.id, f.name)
  }
  const funds: JoinableFund[] = ordered.filter(id => names.has(id)).map(id => ({ id, name: names.get(id)! }))

  if (domain) {
    const { data } = await admin.from('funds').select('id, name').eq('email_domain', domain)
    for (const f of (data as JoinableFund[] | null) ?? []) if (!funds.some(g => g.id === f.id)) funds.push(f)
  }
  return funds
}
