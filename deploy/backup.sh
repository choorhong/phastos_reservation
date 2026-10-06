#!/usr/bin/env bash
# Runs ON THE SERVER, nightly from cron (docs/deployment.md, "Backups"):
# dumps the Postgres database, checks the dump is readable, and uploads it
# to the backup bucket from deploy/aws-setup.yml. Run it by hand to take a
# backup right now:
#
#   ./deploy/backup.sh
#
# Reads from .env.production:
#   BACKUP_BUCKET   the BackupBucketName output of the stack
#   IMAGE_REGISTRY  only to work out the AWS region
#
# The dump is written to a local file first and only uploaded if pg_dump
# succeeded (a failure exits the script) and pg_restore --list reads it as
# a dump with tables, so a failed dump is never stored as a backup. Exits
# non-zero on any failure.
set -euo pipefail

# cron runs with a minimal PATH; the AWS CLI is a snap.
export PATH="$PATH:/snap/bin:/usr/local/bin"

cd "$(dirname "$0")/.."

env_value() { grep -E "^$1=" .env.production | tail -n 1 | cut -d= -f2- || true; }

bucket=$(env_value BACKUP_BUCKET)
if [[ -z $bucket ]]; then
  echo "BACKUP_BUCKET is not set in .env.production" >&2
  exit 1
fi

region_args=()
registry=$(env_value IMAGE_REGISTRY)
if [[ $registry == *.amazonaws.com ]]; then
  region_args=(--region "$(cut -d. -f4 <<<"$registry")")
fi

touch .env.deployed
compose() {
  docker compose -f docker-compose.prod.yml --env-file .env.production --env-file .env.deployed "$@"
}

stamp=$(date -u +%Y%m%dT%H%M%SZ)
dump=$(mktemp "${TMPDIR:-/tmp}/phastos-$stamp.XXXXXX.dump")
trap 'rm -f "$dump"' EXIT

echo "$(date -u +%FT%TZ) dumping database"
# -Fc: compressed custom format, restored with pg_restore. The variables
# expand inside the postgres container (single quotes on purpose).
# shellcheck disable=SC2016
compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$dump"

# Sanity check: the file is a readable dump that contains tables (e.g. not
# an empty file or an error message). --list only reads the dump's table of
# contents; pg_dump's own exit status above is what catches a failed dump.
# Each table is listed twice (definition, then "TABLE DATA"); count it once.
tables=$(compose exec -T postgres pg_restore --list <"$dump" | grep ' TABLE ' | grep -vc ' TABLE DATA ' || true)
if [[ $tables -eq 0 ]]; then
  echo "dump has no tables; not uploading" >&2
  exit 1
fi

key="postgres/$(date -u +%Y/%m)/phastos-$stamp.dump"
aws s3 cp ${region_args[@]+"${region_args[@]}"} --only-show-errors "$dump" "s3://$bucket/$key"
echo "$(date -u +%FT%TZ) uploaded s3://$bucket/$key ($(du -h "$dump" | cut -f1 | tr -d ' '), $tables tables)"
