// Reading and updating a dotenv file (`.env.local`) for `npm run setup`, without disturbing the
// lines it does not touch: comments, blank lines and keys someone added by hand stay as they were.

/** KEY=value pairs. Quotes around a value are removed; `export ` prefixes are allowed. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    let value = m[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    } else {
      // An unquoted value ends at an inline comment.
      value = value.replace(/\s+#.*$/, '')
    }
    out[m[1]] = value
  }
  return out
}

function quote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]*$/.test(value) ? value : JSON.stringify(value)
}

/**
 * The file with `updates` applied: an existing `KEY=` line is rewritten in place (the first one;
 * later duplicates are left alone), a missing key is appended. An undefined value leaves a key as is.
 */
export function updateEnv(text: string, updates: Record<string, string | undefined>): string {
  const lines = text.length ? text.split(/\r?\n/) : []
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const pending = new Map(Object.entries(updates).filter((e): e is [string, string] => e[1] !== undefined))
  for (let i = 0; i < lines.length && pending.size; i++) {
    const m = lines[i].match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (m && pending.has(m[1])) {
      lines[i] = `${m[1]}=${quote(pending.get(m[1])!)}`
      pending.delete(m[1])
    }
  }
  for (const [k, v] of Array.from(pending)) lines.push(`${k}=${quote(v)}`)
  return lines.join('\n') + '\n'
}

/** The legacy anon and service-role keys from `supabase projects api-keys -o json`, if both are there. */
export function supabaseKeysFromCli(json: unknown): { anon: string; serviceRole: string } | null {
  if (!Array.isArray(json)) return null
  const find = (name: string) => {
    const row = json.find(r => r && typeof r === 'object' && (r as any).name === name) as { api_key?: unknown } | undefined
    return typeof row?.api_key === 'string' && row.api_key.length > 20 ? row.api_key : null
  }
  const anon = find('anon')
  const serviceRole = find('service_role')
  return anon && serviceRole ? { anon, serviceRole } : null
}

/** The body for PATCH /v1/projects/{ref}/config/auth: DOCS Step 5, done for you. */
export function authConfigFor(siteUrl: string): Record<string, unknown> {
  const origin = siteUrl.replace(/\/+$/, '')
  return {
    site_url: origin,
    uri_allow_list: `${origin}/**`,
    // Confirm email stays on: LP portal activation binds a login by address (app/api/portal/activate).
    mailer_autoconfirm: false,
    hook_before_user_created_enabled: true,
    hook_before_user_created_uri: 'pg-functions://postgres/public/hook_before_user_created',
  }
}
