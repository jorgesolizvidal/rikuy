#!/usr/bin/env bash
# Loads a backup's data into a database that already has Rikuy's migrations (ADR-046).
#
#   packages/db/scripts/backup-restore-db.sh <backup-dir> <database-url>
#
# In one transaction, with triggers and foreign-key checks off (as the dump expects): empties
# every table the backup carries and loads its rows. Rows the migrations created (queues, job
# kinds, prices, buckets…) are replaced by the backup's own. The schedule (cron) and the Vault
# are not in the backup: the runbook (docs/backup.md) says how to set them up again.
set -euo pipefail

dir="${1:?carpeta del respaldo}"
db="${2:?dirección de la base}"
here="$(cd "$(dirname "$0")" && pwd)"

test -f "$dir/db/data.sql" || { echo "::error title=restore::Falta db/data.sql en el respaldo"; exit 1; }
tables="$(node "$here/backup.mjs" tables "$dir")"
test -n "$tables" || { echo "::error title=restore::El respaldo no trae tablas"; exit 1; }

started=$(date +%s)
errors="$(mktemp)"
trap 'rm -f "$errors"' EXIT
# psql's DETAIL and CONTEXT lines quote the rows (emails, texts): the log only gets the error.
if ! {
  echo "set session_replication_role = replica;"
  echo "truncate $tables cascade;"
  cat "$dir/db/data.sql"
} | psql "$db" -X -q -v ON_ERROR_STOP=1 --single-transaction > /dev/null 2> "$errors"; then
  message="$(grep -m1 -o 'ERROR: .*' "$errors" | cut -c1-160 || true)"
  echo "::error title=restore::No se pudo cargar la base: ${message:-psql falló}"
  exit 1
fi
echo "Base restaurada en $(( $(date +%s) - started )) s"
