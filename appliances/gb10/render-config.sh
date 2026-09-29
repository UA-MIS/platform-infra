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
#
# 2026-09-30 fix: a missing/blank ALERTMANAGER_SLACK_WEBHOOK_URL used to
# be fatal here (`${VAR:?...}`), and this script is ExecStartPre for the
# WHOLE appliance unit -- so no webhook configured meant the unit could
# never start via systemd at all, permanently, appliance-wide, over
# something that only affects alert delivery. The owner has ruled out
# Slack for this deployment, so that was not a hypothetical: it is the
# actual current state of .env, confirmed by `systemctl is-enabled`
# showing "linked" rather than "enabled" -- this unit has never
# successfully completed a start. Degrades instead: no webhook means
# alerts route to Alertmanager's 'null' receiver (accepted and
# evaluated, delivered nowhere) rather than blocking startup. Alerts
# remain visible through Alertmanager's own UI/API either way; only
# push notification delivery is affected, and that was already the
# case before this fix (this failure meant Alertmanager never started
# at all, so nothing -- not even the UI -- was reachable).
set -euo pipefail
cd "$(dirname "$0")"

set -a
source .env
set +a

if [ -n "${ALERTMANAGER_SLACK_WEBHOOK_URL:-}" ]; then
  receiver="slack"
  webhook_url="${ALERTMANAGER_SLACK_WEBHOOK_URL}"
  echo "ALERTMANAGER_SLACK_WEBHOOK_URL is set -- routing alerts to Slack."
else
  receiver="null"
  # Never actually dialed -- route.receiver is 'null', not 'slack', so
  # this api_url is never used to send anything. But it still has to be
  # a SYNTACTICALLY VALID URL: caught live via `amtool check-config`
  # that Alertmanager validates every configured receiver's fields at
  # startup, including ones no route references -- a non-URL string
  # here ("unused-no-webhook-configured", tried first) failed config
  # validation entirely ("unsupported scheme \"\" for URL"), which would
  # have reproduced the exact "appliance-wide fatal over an alerting
  # detail" failure this fix exists to remove, just moved one layer
  # down from the shell script into Alertmanager's own startup check.
  webhook_url="https://unused.invalid/no-webhook-configured"
  echo "ALERTMANAGER_SLACK_WEBHOOK_URL is unset or blank in .env -- alerts" \
       "will be evaluated but NOT delivered anywhere (routed to the" \
       "'null' receiver). Set it in .env and re-run this script (or" \
       "reboot) to enable Slack delivery." >&2
fi

sed \
  -e "s|ROUTE_RECEIVER_PLACEHOLDER|${receiver}|g" \
  -e "s|SLACK_WEBHOOK_URL_PLACEHOLDER|${webhook_url}|g" \
  alertmanager/alertmanager.yml.template > alertmanager/alertmanager.yml

echo "Rendered alertmanager/alertmanager.yml from template (receiver: ${receiver})."
