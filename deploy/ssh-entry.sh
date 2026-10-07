#!/usr/bin/env bash
# Runs ON THE SERVER as the forced command of CI's deploy key
# (docs/deployment-digitalocean.md). In ~/.ssh/authorized_keys:
#
#   command="/home/deploy/phastos_reservation/deploy/ssh-entry.sh",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA... github-actions-deploy
#
# Whatever the client asks for, sshd runs this script instead, with the
# request in SSH_ORIGINAL_COMMAND. The only request accepted is
# "deploy <40-character commit hash>", so the key can't open a shell or run
# anything else even if it leaked. stdin carries two lines from CI: the
# GitHub user and a short-lived token to pull that commit's images from
# ghcr.io (both optional, if the images are public).
set -euo pipefail

request=${SSH_ORIGINAL_COMMAND:-}
if [[ ! $request =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
  echo "refused: this key only accepts 'deploy <40-character commit hash>'" >&2
  exit 2
fi
sha=${BASH_REMATCH[1]}

ghcr_user=''
ghcr_token=''
IFS= read -r ghcr_user || true
IFS= read -r ghcr_token || true

cd "$(dirname "$0")/.."
git fetch --quiet origin
# Check out the commit before running deploy.sh, so the script and compose
# file always match the images. git replaces files rather than editing them
# in place, so this script, already open, keeps running unchanged.
git checkout --quiet --detach "$sha"

GHCR_USER=$ghcr_user GHCR_TOKEN=$ghcr_token exec ./deploy/deploy.sh "$sha"
