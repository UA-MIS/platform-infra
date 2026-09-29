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

# Security review round 4, finding 4 (2026-09-30): `source .env` under
# `set -e` EXECUTES the file as shell, not just reads it as key=value
# pairs. An unquoted .env value containing shell metacharacters --
# ALERTMANAGER_SLACK_WEBHOOK_URL=https://h.example/a|b, say -- parses as
# an assignment PIPED INTO a command named `b`, which does not exist:
# exit 127, `set -e` kills this script, ExecStartPre fails, and the
# WHOLE appliance unit is blocked at boot with a stale (or absent)
# alertmanager.yml on disk. That is precisely the "one bad value blocks
# the entire appliance" failure class the null-receiver fix above
# exists to remove -- reached through the .env LOADER instead of the
# fatal guard this script used to have. `docker compose` itself parses
# .env without shell semantics (plain KEY=VALUE, no expansion, no
# execution) -- sourcing the file was the ONLY thing in this whole
# appliance that ever gave .env content the power to run as code.
# Parse just the one variable this script actually needs, with a plain
# grep/cut, instead. A missing .env file itself is still a distinct,
# fatal, loud error (exit 1) -- unlike a bad VALUE inside it, a missing
# .env is a deployment problem well beyond alerting, and this script has
# no basis to guess what else might be wrong.
if [ ! -f .env ]; then
  echo ".env not found in $(pwd) -- render-config.sh cannot proceed without it." >&2
  exit 1
fi
ALERTMANAGER_SLACK_WEBHOOK_URL="$(grep -m1 '^ALERTMANAGER_SLACK_WEBHOOK_URL=' .env | cut -d= -f2- || true)"

if [ -z "${ALERTMANAGER_SLACK_WEBHOOK_URL}" ]; then
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
elif [[ "${ALERTMANAGER_SLACK_WEBHOOK_URL}" =~ ^https:// ]]; then
  receiver="slack"
  webhook_url="${ALERTMANAGER_SLACK_WEBHOOK_URL}"
  echo "ALERTMANAGER_SLACK_WEBHOOK_URL is set -- routing alerts to Slack."
else
  # Security review round 4, finding 3 (2026-09-30): the earlier version
  # of this fix validated only PRESENCE, not SHAPE -- a malformed value
  # (missing scheme, a typo, a copy-paste that dropped characters) still
  # rendered `receiver: 'slack'` with an invalid api_url and exited 0.
  # The appliance would boot -- ExecStartPre "succeeded" -- but
  # Alertmanager itself would then crash-loop on that config, pushing
  # the exact fatal-appliance-wide failure this script exists to remove
  # one layer further down, into a place with far worse visibility (a
  # crash-looping container, not a non-zero ExecStartPre systemd already
  # reports clearly). Fall back to the same null-receiver degradation as
  # a genuinely blank value, but with a LOUD warning naming the actual
  # problem, since this case means someone tried to configure Slack and
  # got it wrong, not that Slack was deliberately skipped.
  receiver="null"
  webhook_url="https://unused.invalid/no-webhook-configured"
  echo "WARNING: ALERTMANAGER_SLACK_WEBHOOK_URL is set but does not look" \
       "like a valid https:// URL (got: ${ALERTMANAGER_SLACK_WEBHOOK_URL@Q})." \
       "Falling back to the 'null' receiver -- alerts will be evaluated" \
       "but NOT delivered anywhere -- rather than shipping a broken" \
       "Slack config that would crash-loop Alertmanager after the" \
       "appliance has already booted. Fix the value in .env and re-run" \
       "this script (or reboot)." >&2
fi

sed \
  -e "s|ROUTE_RECEIVER_PLACEHOLDER|${receiver}|g" \
  -e "s|SLACK_WEBHOOK_URL_PLACEHOLDER|${webhook_url}|g" \
  alertmanager/alertmanager.yml.template > alertmanager/alertmanager.yml

echo "Rendered alertmanager/alertmanager.yml from template (receiver: ${receiver})."
