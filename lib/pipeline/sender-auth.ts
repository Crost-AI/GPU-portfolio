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
 * The envelope sender in a Received-SPF value, or null unless there is exactly one and it is a plain
 * address. Postmark's format lists the sending server's `helo=` first, and the sender chooses both
 * that and the local part, so `envelope-from=` found anywhere in the value proves nothing: a HELO can
 * say it, and `"a@member.example"@attacker.example` reads as the member up to the quote (Crost #142).
 * A genuine address this turns away only loses the member's treatment; its mail still arrives.
 */
function envelopeSender(spf: string): string | null {
  const values = spf.split(';')
    .map(field => field.trim().match(/^envelope-from=(.*)$/i)?.[1])
    .filter((v): v is string => v !== undefined)
  if (values.length !== 1) return null
  const m = values[0].trim().match(/^(?:"([^\s"<>@]+@[^\s"<>@]+)"|<([^\s"<>@]+@[^\s"<>@]+)>|([^\s"<>@]+@[^\s"<>@]+))$/)
  return m ? m[1] ?? m[2] ?? m[3] : null
}

/**
 * Postmark: the topmost Received-SPF header is a pass for an envelope sender aligned with From.
 *
 * Only that header counts, on the ASSUMPTION that the first one in the forwarded headers is
 * Postmark's own, as a receiver adds its trace headers above the message's. Postmark's documentation
 * (https://postmarkapp.com/developer/user-guide/inbound/parse-an-email) shows the header but does not
 * state the order, and no real message has tested it. Authentication-Results is NOT trusted: Postmark
 * forwards every header the message carried, nothing guarantees the first such header was written by
 * its receiver, and a sender can supply one claiming `dmarc=pass` (Crost #136). Without a Received-SPF
 * the answer is no: the mail is still accepted from an authorized sender, but never gets a member's
 * treatment.
 */
export function postmarkSenderVerified(from: string, headers: Header[] | null | undefined): boolean {
  const fromDomain = domainOf(from)
  if (!fromDomain || !Array.isArray(headers)) return false
  const spf = headers.find(h => h?.Name?.toLowerCase() === 'received-spf')?.Value ?? null
  if (!spf || !/^\s*pass\b/i.test(spf)) return false
  const sender = envelopeSender(spf)
  return sender !== null && aligned(fromDomain, sender)
}
