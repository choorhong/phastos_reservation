#!/usr/bin/env bash
# Runs ON THE SERVER: pulls the images for one commit and (re)starts the
# production stack with them. CI calls it after checking out that commit:
# over SSH through deploy/ssh-entry.sh (DigitalOcean), or through AWS Systems
# Manager with deploy/ssm-deploy.sh (AWS). It can also be run by hand to
# deploy or roll back to any commit CI has pushed images for:
#
#   git fetch && git checkout --detach <commit> && ./deploy/deploy.sh <commit>
#
# Reads from .env.production:
#   IMAGE_REGISTRY    where CI pushes the images: ghcr.io/<owner>, or an
#                     ECR registry like 123456789012.dkr.ecr.ap-southeast-1.amazonaws.com
#
# From the environment (optional): GHCR_USER and GHCR_TOKEN, to log in to
# ghcr.io for the pull; ssh-entry.sh passes CI's short-lived token. Not
# needed if the images are public.
#   COMPOSE_PROFILES  optional; "proxy" to run the bundled Caddy
#
# On success it records the commit in .env.deployed (IMAGE_TAG=<commit>),
# which the `dcp` alias in docs/deployment.md also reads, so a later
# `dcp up -d` by hand uses the deployed images rather than `latest`.
set -euo pipefail

tag=${1:?usage: deploy/deploy.sh <commit-sha>}
cd "$(dirname "$0")/.."

env_value() { grep -E "^$1=" .env.production | tail -n 1 | cut -d= -f2- || true; }

registry=$(env_value IMAGE_REGISTRY)
if [[ -z $registry ]]; then
  echo "IMAGE_REGISTRY is not set in .env.production" >&2
  exit 1
fi

# ECR needs a docker login; the instance role supplies the credentials.
if [[ $registry == *.amazonaws.com ]]; then
  region=$(cut -d. -f4 <<<"$registry")
  aws ecr get-login-password --region "$region" |
    docker login --username AWS --password-stdin "$registry" >/dev/null
fi

# The exported IMAGE_TAG wins over the previous release's .env.deployed
# until this deploy has succeeded.
export IMAGE_TAG=$tag
touch .env.deployed
compose() {
  docker compose -f docker-compose.prod.yml --env-file .env.production --env-file .env.deployed "$@"
}

if [[ $registry == ghcr.io/* && -n ${GHCR_TOKEN:-} ]]; then
  printf '%s' "$GHCR_TOKEN" |
    docker login ghcr.io --username "${GHCR_USER:-github-actions}" --password-stdin >/dev/null
fi

echo "Pulling images for $tag"
compose pull --quiet

# CI's token expires when its job ends. Don't leave it saved in Docker's
# config, or later pulls would send an expired token and be refused.
if [[ $registry == ghcr.io/* && -n ${GHCR_TOKEN:-} ]]; then
  docker logout ghcr.io >/dev/null
fi

# --wait: fail the deploy (and so the CI job) unless every service ends up
# healthy -- `migrate` must exit 0 before the apps even start.
echo "Starting"
compose up -d --no-build --remove-orphans --wait --wait-timeout 300

# Drop this app's images from previous releases so they don't fill the
# disk. Only phastos-* images from IMAGE_REGISTRY: never a blanket
# `docker image prune --all`, which would also delete other apps' images on
# a shared host.
docker images --format '{{.Repository}}:{{.Tag}}' "$registry/phastos-*" |
  grep -v ":$tag\$" | xargs -r docker rmi >/dev/null 2>&1 || true

echo "IMAGE_TAG=$tag" >.env.deployed
compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}'
echo "Deployed $tag"
