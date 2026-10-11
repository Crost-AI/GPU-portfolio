/**
 * Validate a `?next=` destination before redirecting a user to it.
 *
 * WHY THIS IS ITS OWN MODULE: the obvious check —
 *
 *     next.startsWith('/') && !next.startsWith('//')
 *
 * is WRONG, and wrong in a way that looks right. For special schemes (http/https)
 * the WHATWG URL spec treats a backslash exactly like a forward slash, so
 *
 *     new URL('/\\evil.com', 'https://app.example.com')  ->  https://evil.com/
 *
 * `/\evil.com` passes both of those conditions and still leaves the origin. Next's
 * router resolves the href against location and hard-navigates when the origin
 * differs, so the user is handed to the attacker's site.
 *
 * That matters most on exactly the pages that use this: a redirect fired
 * IMMEDIATELY AFTER a successful sign-in or MFA prompt is a phishing primitive —
 * the victim sees the real domain and a real TLS cert, authenticates, and is then
 * bounced somewhere hostile while they still believe they're inside the app.
 *
 * So: allowlist, don't blocklist. A destination must be a plain same-origin path.
 */

export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw) return null

  // Must be a rooted path...
  if (!raw.startsWith('/')) return null

  // ...and not a protocol-relative URL, in either slash flavour. `//evil.com` and
  // `/\evil.com` (and `/\/evil.com`) all escape the origin.
  if (raw.startsWith('//')) return null
  if (raw.includes('\\')) return null

  // Control characters and whitespace get stripped or normalized by URL parsers in
  // ways that can re-introduce an escape (e.g. "/\tevil.com"). Nothing legitimate
  // needs them.
  if (/[\x00-\x1f\x7f]/.test(raw)) return null

  // Percent-encoded slashes and backslashes in the PATH. `new URL` leaves `%2f`/`%5c` encoded, so
  // the origin check below passes, but anything downstream that decodes the path once (a proxy,
  // a framework rewrite, a second redirect hop) turns `/%2f%2fevil.com` or `/%5cevil.com` back
  // into the escape. Decode the path (not the query — `?redirect_uri=https%3A%2F%2F…` is
  // legitimate, see the OAuth resume case) a few rounds and re-apply the slash checks.
  const path = raw.split(/[?#]/, 1)[0]
  let decoded = path
  for (let i = 0; i < 3; i++) {
    let next: string
    try {
      next = decodeURIComponent(decoded)
    } catch {
      return null
    }
    if (next.startsWith('//') || next.includes('\\') || /[\x00-\x1f\x7f]/.test(next)) return null
    if (next === decoded) break
    decoded = next
  }

  // Belt and braces: resolve it and confirm it really is same-origin. Any scheme
  // or authority that survived the checks above dies here.
  try {
    const resolved = new URL(raw, 'https://placeholder.invalid')
    if (resolved.origin !== 'https://placeholder.invalid') return null
  } catch {
    return null
  }

  return raw
}
