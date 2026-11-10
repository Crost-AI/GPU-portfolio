// Which fund a Postmark inbound email belongs to.
//
// Postmark forwards every address on a server's inbound domain to that server's webhook, so the
// part before the @ is whatever the sender typed. A fund is matched by its saved inbound address
// exactly (ignoring case and a +tag), and failing that by the address's domain, the way Resend
// inbound matches (lib/resend/inbound.ts). So with an inbound domain such as
// fund.inbound.example.com, receipts@ and updates@ reach the fund as well as the saved address.
//
// Postmark gives each server one inbound domain and one webhook URL, and the URL carries one fund's
// token, so two funds need two Postmark servers, each with its own inbound domain.
//
// Postmark's shared default domain (abc123@inbound.postmarkapp.com) is the exception: there the
// part before the @ names the server, so only the exact address matches.

const SHARED_DOMAINS = new Set(['inbound.postmarkapp.com'])

export function matchPostmarkInbound<T extends { postmark_inbound_address: string | null }>(
  toAddress: string,
  rows: T[],
  /** Addresses with a meaning of their own (the deployment's global inbound address): exact only. */
  reserved: Array<string | null | undefined> = [],
): T | null {
  const recipient = normalize(toAddress)
  if (!recipient) return null

  const exact = rows.filter(r => normalize(r.postmark_inbound_address) === recipient)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) {
    console.error(`[inbound-email] Ambiguous routing: ${recipient} is the inbound address of ${exact.length} funds`)
    return null
  }

  const domain = recipient.split('@')[1]
  if (!domain || SHARED_DOMAINS.has(domain)) return null
  if (reserved.some(r => normalize(r) === recipient)) return null
  const sameDomain = rows.filter(r => normalize(r.postmark_inbound_address)?.split('@')[1] === domain)
  if (sameDomain.length === 1) return sameDomain[0]
  if (sameDomain.length > 1) {
    console.error(`[inbound-email] Ambiguous routing: ${sameDomain.length} funds receive on ${domain}; only their exact addresses route`)
  }
  return null
}

/** Lowercase bare address with any +tag removed, from "Name <a+tag@b>" or "a@b". */
function normalize(value: string | null | undefined): string | null {
  if (!value) return null
  const first = value.split(',')[0]
  const address = (first.match(/<([^>]+)>/)?.[1] ?? first).trim().toLowerCase()
  const [local, domain] = address.split('@')
  if (!local || !domain) return null
  return `${local.split('+')[0]}@${domain}`
}
