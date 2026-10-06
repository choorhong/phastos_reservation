#!/usr/bin/env bash
# Runs IN CI (.github/workflows/ci.yml, deploy job), with AWS credentials
# from the GitHub OIDC role: asks Systems Manager to run deploy/deploy.sh on
# the instance(s) tagged App=<tag value>, waits for it, and prints its
# output. Exits non-zero if the deploy failed or no instance was reached.
#
#   deploy/ssm-deploy.sh <commit-sha> [tag-value]
set -euo pipefail

sha=${1:?usage: deploy/ssm-deploy.sh <commit-sha> [tag-value]}
tag_value=${2:-phastos}

# Runs as root on the instance; switch to the user that owns the checkout
# (and is in the docker group). The commit is checked out before deploy.sh
# runs, so the script and compose file always match the images.
remote="cd ~/phastos_reservation && git fetch --quiet origin && git checkout --quiet --detach $sha && ./deploy/deploy.sh $sha"
params=$(jq -n --arg cmd "runuser -u ubuntu -- bash -lc '$remote'" \
  '{commands: [$cmd], executionTimeout: ["900"]}')

command_id=$(aws ssm send-command \
  --document-name AWS-RunShellScript \
  --targets "Key=tag:App,Values=$tag_value" \
  --comment "deploy ${sha:0:7}" \
  --parameters "$params" \
  --query Command.CommandId --output text)
echo "SSM command $command_id: deploying ${sha:0:7} to App=$tag_value"

status=Pending
for _ in $(seq 1 100); do # up to ~16 minutes
  sleep 10
  status=$(aws ssm list-commands --command-id "$command_id" --query 'Commands[0].Status' --output text)
  case $status in
    Pending | InProgress | Cancelling) ;;
    *) break ;;
  esac
done

targets=$(aws ssm list-commands --command-id "$command_id" --query 'Commands[0].TargetCount' --output text)
aws ssm list-command-invocations --command-id "$command_id" --details \
  --query 'CommandInvocations[].[InstanceId, Status, CommandPlugins[0].Output]' --output text || true

echo "Status: $status (targets: $targets)"
if [[ $targets == 0 ]]; then
  echo "No instance matched tag App=$tag_value, or its SSM agent isn't online." >&2
  exit 1
fi
[[ $status == Success ]]
