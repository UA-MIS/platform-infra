{{/*
FAIL-GUARDS. The ApplicationSet hasKey-guards every field it passes, so a
malformed tenants/_boards/*.yaml arrives here as an EMPTY STRING rather than
aborting the whole ApplicationSet render (the labs-students C-2 precedent).
That is deliberate — but an empty team must then die LOUDLY here, scoped to this
one Application, instead of rendering a board named "-agile" that half-works.
*/}}

{{- define "agile-board.team" -}}
{{- $t := .Values.team | trim -}}
{{- if or (empty $t) (eq $t "PLACEHOLDER-team") -}}
{{- fail "agile-board: .Values.team is required (the GitHub Team slug). Rendering the bare chart is not supported — a board is always rendered from tenants/_boards/<team>.yaml by applicationsets/agile-boards-appset.yaml." -}}
{{- end -}}
{{- if not (regexMatch "^[a-z]([-a-z0-9]*[a-z0-9])?$" $t) -}}
{{- fail (printf "agile-board: team %q is not a DNS-1123 label. It is used verbatim as the host label, the Postgres schema and the OIDC group suffix, so a non-conforming value cannot be silently coerced." $t) -}}
{{- end -}}
{{- if gt (len $t) 30 -}}
{{- fail (printf "agile-board: team %q exceeds 30 characters (matches the CapstoneTenant XRD bound)." $t) -}}
{{- end -}}
{{- $t -}}
{{- end -}}

{{- define "agile-board.repos" -}}
{{- $r := .Values.repos | trim -}}
{{- if or (empty $r) (eq $r "PLACEHOLDER-repos") -}}
{{- fail (printf "agile-board: .Values.repos is required for team %q. Without it the board has no repo to open branches against and the assignee/PR pickers are inert." .Values.team) -}}
{{- end -}}
{{- $r -}}
{{- end -}}

{{/* Image tag: NEVER default to `latest` — Kyverno disallow-latest-tag is Enforce. */}}
{{- define "agile-board.imageTag" -}}
{{- $t := .Values.image.tag | trim -}}
{{- if or (empty $t) (eq $t "PLACEHOLDER-tag") (eq $t "latest") -}}
{{- fail "agile-board: .Values.image.tag must be an explicit immutable tag. `latest` is refused by the Kyverno disallow-latest-tag ClusterPolicy (Enforce), and an empty tag would render an unpullable ref." -}}
{{- end -}}
{{- $t -}}
{{- end -}}

{{/* Resource name: <team>-agile. Distinct from any tenant workload name. */}}
{{- define "agile-board.name" -}}
{{- printf "%s-agile" (include "agile-board.team" .) -}}
{{- end -}}

{{/* Public host — a SINGLE hyphenated label under the wildcard. */}}
{{- define "agile-board.host" -}}
{{- printf "%s-agile.%s" (include "agile-board.team" .) .Values.domain -}}
{{- end -}}

{{- define "agile-board.appUrl" -}}
{{- printf "https://%s" (include "agile-board.host" .) -}}
{{- end -}}

{{/*
The OIDC redirect URI. Derived from the SAME helper as the Ingress host and
APP_URL, so the three can never disagree — a mismatch between them surfaces as an
opaque OIDC error at sign-in rather than at startup, which is the single most
expensive failure mode this app has (platform-services/dex/configmap.yaml).
The generator that maintains the Dex client's redirectURIs list derives the
identical string from tenants/_boards/, and `make validate` fails on drift.
*/}}
{{- define "agile-board.redirectUri" -}}
{{- printf "%s/api/auth/callback" (include "agile-board.appUrl" .) -}}
{{- end -}}

{{- define "agile-board.title" -}}
{{- $t := .Values.title | trim -}}
{{- if empty $t -}}{{- printf "%s Board" (include "agile-board.team" .) -}}{{- else -}}{{- $t -}}{{- end -}}
{{- end -}}

{{/*
The homepage seed document, with this board's OWN team slug substituted in.

Returns "" when .Values.homepage is unset — the overwhelmingly common case. The
caller then omits HOME_TEMPLATE entirely and the app uses its built-in starter
template, which is what every board does today. Optional is not a nicety here:
four live boards set nothing, and a required field would break all four.

WHY THE SUBSTITUTION IS THE POINT. The document is written once and says
`__TEAM__` (the placeholder convention this repo already uses, as in
tenants/_template/); each board renders it with its own slug. A shared copy
naming one team's hosts would be WORSE than no document at all — a student would
follow it to another team's VM, be refused by that team's GitHub-team check, and
read the refusal as their own account being broken.

FAILS LOUDLY, like every other guard in this file. A homepage naming a document
that is not in the chart is a silent regression otherwise: `.Files.Get` returns
"" for a missing path, the ConfigMap key is dropped, the board comes up Healthy
and serves the generic starter text, and nobody notices the doc is missing until
a student asks where it went. Scoped to this one Application, per the
hasKey/fail-guard split documented at the top of this file.
*/}}
{{- define "agile-board.homepage" -}}
{{- $doc := .Values.homepage | default "" | trim -}}
{{- if $doc -}}
{{- if not (regexMatch "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$" $doc) -}}
{{- fail (printf "agile-board: homepage %q must be a bare document name (lowercase, digits and hyphens) naming files/homepage/<name>.md — not a path and not a filename. Anything else is either a typo or an attempt to read outside the chart." $doc) -}}
{{- end -}}
{{- $path := printf "files/homepage/%s.md" $doc -}}
{{- $body := .Files.Get $path -}}
{{- if not $body -}}
{{- fail (printf "agile-board: homepage %q names %s, which is missing or empty in the chart. Add the document, or drop the `homepage:` key to fall back to the app's built-in starter template." $doc $path) -}}
{{- end -}}
{{- $team := include "agile-board.team" . -}}
{{- $body | replace "__TEAM__" $team -}}
{{- end -}}
{{- end -}}

{{- define "agile-board.labels" -}}
app.kubernetes.io/name: agile-board
app.kubernetes.io/instance: {{ include "agile-board.name" . }}
app.kubernetes.io/component: agile-board
platform.capstone/component: platform
platform.capstone/team: {{ include "agile-board.team" . | quote }}
{{- end -}}

{{- define "agile-board.selectorLabels" -}}
app.kubernetes.io/name: agile-board
app.kubernetes.io/instance: {{ include "agile-board.name" . }}
{{- end -}}
