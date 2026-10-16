#!/usr/bin/env bash
# The first admin, with no email delivery needed.
#
#   deploy/local/scripts/bootstrap-admin.sh --email you@firm.com --fund "Your Fund" [bootstrap flags]
#
# 1. Runs `npm run bootstrap` (scripts/bootstrap-fund.ts) inside the app container: adds the email
#    to allowed_signups, creates the confirmed account, creates the fund with that account as its
#    admin, and prints an API key. Every argument is passed through to it.
# 2. Sets a password on the account through GoTrue's admin API, so you can sign in at /auth with
#    email + password instead of a magic link. The password comes from ADMIN_PASSWORD in the
#    environment, or a prompt; never from the command line. Leave both empty to skip this step.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
dc() { docker compose -f "$here/docker-compose.yml" --env-file "$here/.env" "$@"; }

email=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do [[ "${args[$i]}" == "--email" ]] && email="${args[$((i + 1))]:-}"; done
[[ -n "$email" ]] || { echo "usage: $0 --email you@firm.com --fund \"Your Fund\" [other npm run bootstrap flags]" >&2; exit 1; }

dc exec -T app npm run bootstrap -- "$@"

if [[ -z "${ADMIN_PASSWORD:-}" ]]; then
  read -r -s -p "Password for $email (min 6 characters; empty = magic link only): " ADMIN_PASSWORD; echo
fi
[[ -n "$ADMIN_PASSWORD" ]] || { echo "No password set: sign in with a magic link (needs SMTP or --profile mail)."; exit 0; }
export ADMIN_PASSWORD ADMIN_EMAIL="$email"

# Inside the app container: localhost:8000 there is Kong, and SUPABASE_SERVICE_ROLE_KEY is set.
# `-e NAME` with no value hands the variable over without putting it on a command line.
dc exec -T -e ADMIN_PASSWORD -e ADMIN_EMAIL app node -e '
const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY
const email = process.env.ADMIN_EMAIL.trim().toLowerCase()
const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" }
;(async () => {
  let user
  for (let page = 1; !user && page <= 20; page++) {
    const res = await fetch(`${url}/auth/v1/admin/users?page=${page}&per_page=1000`, { headers })
    if (!res.ok) throw new Error(`listing users: ${res.status} ${await res.text()}`)
    const { users } = await res.json()
    user = users.find(u => u.email?.toLowerCase() === email)
    if (users.length < 1000) break
  }
  if (!user) throw new Error(`no account for ${email}`)
  const res = await fetch(`${url}/auth/v1/admin/users/${user.id}`, {
    method: "PUT", headers, body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }),
  })
  if (!res.ok) throw new Error(`setting the password: ${res.status} ${await res.text()}`)
  console.log(`Password set for ${email}. Sign in at ${process.env.NEXT_PUBLIC_SITE_URL}/auth`)
})().catch(e => { console.error(e.message); process.exit(1) })
'
