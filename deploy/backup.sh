#!/usr/bin/env bash
# Runs ON THE SERVER, nightly from cron (docs/deployment.md, "Backups"):
# dumps the Postgres database, checks the dump is readable, and uploads it
# to an S3-compatible bucket. Run it by hand to take a backup right now:
#
#   ./deploy/backup.sh
#
# Where it uploads:
# - Cloudflare R2 (or any S3-compatible store), from .env.backup:
#     BACKUP_BUCKET, BACKUP_S3_ENDPOINT (https://<account id>.r2.cloudflarestorage.com),
#     AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (an R2 API token's keys)
#   A separate file, so these keys never reach the app containers, which
#   all get .env.production.
# - AWS S3, from .env.production: BACKUP_BUCKET (the BackupBucketName output
#   of deploy/aws-setup.yml), with the instance role's credentials; the
#   region comes from IMAGE_REGISTRY.
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

if [[ -f .env.backup ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.backup
  set +a
fi

bucket=${BACKUP_BUCKET:-$(env_value BACKUP_BUCKET)}
if [[ -z $bucket ]]; then
  echo "BACKUP_BUCKET is not set (in .env.backup, or .env.production on AWS)" >&2
  exit 1
fi

s3_args=()
registry=$(env_value IMAGE_REGISTRY)
if [[ -n ${BACKUP_S3_ENDPOINT:-} ]]; then
  s3_args=(--endpoint-url "$BACKUP_S3_ENDPOINT" --region auto)
elif [[ $registry == *.amazonaws.com ]]; then
  s3_args=(--region "$(cut -d. -f4 <<<"$registry")")
fi

touch .env.deployed
compose() {
  docker compose -f docker-compose.prod.yml --env-file .env.production --env-file .env.deployed "$@"
}

stamp=$(date -u +%Y%m%dT%H%M%SZ)
dump=$(mktemp "${TMPDIR:-/tmp}/phastos-$stamp.XXXXXX")
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
aws s3 cp ${s3_args[@]+"${s3_args[@]}"} --only-show-errors "$dump" "s3://$bucket/$key"
echo "$(date -u +%FT%TZ) uploaded s3://$bucket/$key ($(du -h "$dump" | cut -f1 | tr -d ' '), $tables tables)"
