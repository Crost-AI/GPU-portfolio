// Is an inbound email really from the address in its From header? The From header is the sender's
// own claim; SPF, DKIM and DMARC are what the receiving server checked. Mail that is not shown to be
// from that domain is still accepted from an authorized sender, but never gets a member's treatment
// (the receipt branch, interactions, skipping the authorized-senders list).

import type { ResendAuthentication } from '@/lib/resend/inbound'

const domainOf = (address: string) => address.split('@')[1]?.trim().toLowerCase().replace(/>$/, '') ?? ''

/** `d` is the From domain or a parent of it (relaxed alignment, as DMARC defines it). */
function aligned(fromDomain: string, d: string | undefined): boolean {
  const x = (d ?? '').trim().toLowerCase().replace(/^.*@/, '')
  return !!x && !!fromDomain && (fromDomain === x || fromDomain.endsWith(`.${x}`) || x.endsWith(`.${fromDomain}`))
}

/** Resend: DMARC passed, so SPF or DKIM passed aligned with the From domain. */
export function resendSenderVerified(auth: ResendAuthentication | null): boolean {
  return auth?.dmarc === 'pass'
}

type Header = { Name?: string; Value?: string }

/**
 * Postmark: the topmost Received-SPF header is a pass for an envelope sender aligned with From.
 *
 * Only that header counts. Postmark's receiving server prepends Received-SPF to every inbound
 * message (https://postmarkapp.com/developer/user-guide/inbound/parse-an-email), so the first one in
 * the forwarded headers is Postmark's own; any copy the sender wrote comes below it. Authentication-
 * Results is NOT trusted: Postmark forwards every header the message carried, nothing guarantees the
 * first such header was written by its receiver, and a sender can supply one claiming `dmarc=pass`
 * (Crost #136). Without a Received-SPF the answer is no: the mail is still accepted from an
 * authorized sender, but never gets a member's treatment.
 */
export function postmarkSenderVerified(from: string, headers: Header[] | null | undefined): boolean {
  const fromDomain = domainOf(from)
  if (!fromDomain || !Array.isArray(headers)) return false
  const spf = headers.find(h => h?.Name?.toLowerCase() === 'received-spf')?.Value ?? null
  if (!spf || !/^\s*pass\b/i.test(spf)) return false
  const m = spf.match(/envelope-from=["<]?([^\s">;]+)/i)
  return aligned(fromDomain, m?.[1])
}
