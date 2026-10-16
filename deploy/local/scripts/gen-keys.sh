#!/usr/bin/env bash
# Write deploy/local/.env from .env.example with fresh secrets. Refuses to overwrite an existing
# .env (its ENCRYPTION_KEY and POSTGRES_PASSWORD are tied to your data) unless --force.
# Needs node (the host's, or the node image through docker); no npm packages.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
env_file="$here/.env"

if [[ -f "$env_file" && "${1:-}" != "--force" ]]; then
  echo "$env_file exists; not overwriting (pass --force to replace it, and lose its keys)." >&2
  exit 1
fi

# Reads .env.example on stdin, prints it with the secrets filled in.
script='
const { randomBytes, createHmac } = require("crypto")
const b64 = v => Buffer.from(JSON.stringify(v)).toString("base64url")
const hex = n => randomBytes(n).toString("hex")
const jwtSecret = hex(32)
const now = Math.floor(Date.now() / 1000)
const jwt = role => {
  const body = b64({ alg: "HS256", typ: "JWT" }) + "." + b64({ role, iss: "supabase", iat: now, exp: now + 10 * 365 * 24 * 3600 })
  return body + "." + createHmac("sha256", jwtSecret).update(body).digest("base64url")
}
const secrets = {
  POSTGRES_PASSWORD: hex(24), JWT_SECRET: jwtSecret, ANON_KEY: jwt("anon"), SERVICE_ROLE_KEY: jwt("service_role"),
  ENCRYPTION_KEY: hex(32), CRON_SECRET: hex(32), PG_META_CRYPTO_KEY: hex(32),
}
const example = require("fs").readFileSync(0, "utf8")
process.stdout.write(example.replace(/^([A-Z_]+)=.*$/gm, (line, key) => key in secrets ? key + "=" + secrets[key] : line))
'

umask 077
tmp="$(mktemp "$here/.env.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
if command -v node >/dev/null; then
  node -e "$script" < "$here/.env.example" > "$tmp"
else
  docker run --rm -i node:22.23.3-bookworm-slim node -e "$script" < "$here/.env.example" > "$tmp"
fi
mv "$tmp" "$env_file"
echo "Wrote $env_file. Back it up somewhere safe: ENCRYPTION_KEY cannot be recovered."
