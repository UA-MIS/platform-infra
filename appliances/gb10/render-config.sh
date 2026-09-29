#!/usr/bin/env bash
# appliances/gb10/render-config.sh
#
# Renders alertmanager/alertmanager.yml from alertmanager/alertmanager.yml.template
# and .env, ON THE HOST — the official Alertmanager image has no shell/envsubst
# inside the container, so this substitution can't happen at container start.
#
# The systemd unit (deploy/gb10-appliance.service) already calls this as
# ExecStartPre on every boot, before `docker compose up`. Before this file
# existed, `systemd-analyze verify` on that unit failed because it referenced
# a script that didn't exist on disk — this file is what makes that check
# pass. It must be executable (git preserves the mode bit set when this file
# was committed; if a future checkout loses it, `chmod +x render-config.sh`).
set -euo pipefail
cd "$(dirname "$0")"

set -a
source .env
set +a

: "${ALERTMANAGER_SLACK_WEBHOOK_URL:?ALERTMANAGER_SLACK_WEBHOOK_URL not set in .env}"

sed "s|SLACK_WEBHOOK_URL_PLACEHOLDER|${ALERTMANAGER_SLACK_WEBHOOK_URL}|g" \
  alertmanager/alertmanager.yml.template > alertmanager/alertmanager.yml

echo "Rendered alertmanager/alertmanager.yml from template."
