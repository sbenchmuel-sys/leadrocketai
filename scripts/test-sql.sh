#!/usr/bin/env bash
# Runs the SQL behavioural checks in supabase/tests/*.test.sql against a throwaway
# database on a local Postgres. Needs `psql` + a reachable server (defaults below
# match GitHub's ubuntu runners once the postgresql service is started; locally,
# export PGHOST/PGPORT/PGUSER as needed).
#
# Each run: create a fresh DB → load supabase/tests/fixture_schema.sql → apply the
# migrations listed in supabase/tests/migrations.list → run every *.test.sql.
set -euo pipefail
cd "$(dirname "$0")/.."

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
DB="drivepilot_sqltest_$$"

psql -v ON_ERROR_STOP=1 -q -d postgres -c "CREATE DATABASE ${DB};"
trap 'psql -q -d postgres -c "DROP DATABASE IF EXISTS ${DB};" >/dev/null' EXIT

psql -v ON_ERROR_STOP=1 -q -d "$DB" -f supabase/tests/fixture_schema.sql
while read -r mig; do
  [[ -z "$mig" || "$mig" == \#* ]] && continue
  psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "supabase/migrations/${mig}"
done < supabase/tests/migrations.list

status=0
for t in supabase/tests/*.test.sql; do
  if psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$t"; then
    echo "PASS $t"
  else
    echo "FAIL $t"; status=1
  fi
done
exit $status
