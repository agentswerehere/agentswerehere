#!/usr/bin/env bash
# Weekly logical backup. Writes a gzipped pg_dump on this machine. Does not upload it.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "pg_dump is not installed. Install the PostgreSQL client tools, then run this again." >&2
  exit 1
fi
if ! command -v gzip >/dev/null 2>&1; then
  echo "gzip is not installed." >&2
  exit 1
fi

database_url="${DATABASE_URL:-}"
if [[ -z "$database_url" && -f .env ]]; then
  database_url="$(ENV_FILE="$root/.env" node --input-type=module <<'JS'
import { readFileSync } from "node:fs";
const text = readFileSync(process.env.ENV_FILE, "utf8");
for (const line of text.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("DATABASE_URL=")) continue;
  let value = trimmed.slice("DATABASE_URL=".length).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  process.stdout.write(value);
  break;
}
JS
)"
fi

if [[ -z "$database_url" ]]; then
  echo "Set DATABASE_URL or put it in .env. Use the Neon direct (non-pooled) string for pg_dump." >&2
  exit 1
fi

mkdir -p "$root/backups"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$root/backups/awh-${stamp}.sql.gz"
pg_dump --no-owner --no-acl "$database_url" | gzip -c > "$out"
echo "Wrote backups/awh-${stamp}.sql.gz"
