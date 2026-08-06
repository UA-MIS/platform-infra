{{/*
Shared naming + VALIDATION — defined ONCE here so namespace mode and studentApp
mode can never diverge on what "the lab's namespace" or "the student's app
name" means, and so every value derived from fleet-repo data (potentially a
slides bug, or a student's own CI writing an untrusted tag) is validated
BEFORE it is ever interpolated into a manifest. See README "Contract: lowercase
everywhere" and "Contract: required + validated fields" for what this enforces
and why.

DESIGN NOTE (adversarial review C-2): the ApplicationSet templates
(applicationsets/labs-*-appset.yaml) use `hasKey`-guarded access for every
field, so a fleet-repo row missing a field NEVER causes ArgoCD's own
`missingkey=error` template render to abort — it always renders SOMETHING
(an empty string when a field is absent) into `valuesObject`. This chart is
therefore the ONE place all validation actually happens, and `fail` here
aborts only THIS Application's `helm template` call — never the rest of the
fleet.
*/}}

{{- define "lab-app.labSlug" -}}
{{- $v := .Values.labSlug | default "" -}}
{{- if not (regexMatch "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$" $v) -}}
{{ fail (printf "labSlug %q is missing, empty, or not lowercase+DNS-safe. Contract (README 'Contract: lowercase everywhere'): slides writes lab.yaml/students.yaml with labSlug already matching ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$." $v) }}
{{- end -}}
{{- $v -}}
{{- end -}}

{{/* GitHub usernames are DNS-safe by GitHub's own policy (alnum + single
     internal hyphens, no leading/trailing/double hyphen) IF already lowercase
     — but nothing forces slides to write students.yaml lowercased, and the
     `labs-students` merge generator's mergeKeys are an EXACT STRING match
     against the tag file's already-lowercased username (written by the
     SCHEDULED `.github/workflows/lab-tag-sync.yaml`, not student CI — see
     README "Security hardening: H-2"). A case mismatch there does not error
     — it just silently never merges, pinning the student on the chart's
     `:unreleased` placeholder forever with no visible failure ANYWHERE
     (adversarial review C-1). Failing loudly here converts that silent,
     permanent breakage into a visible, per-Application Degraded status the
     first time it would matter. */}}
{{- define "lab-app.username" -}}
{{- $v := .Values.username | default "" -}}
{{- if not (regexMatch "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$" $v) -}}
{{ fail (printf "username %q is missing, empty, or not already lowercase+DNS-safe. Contract (README 'Contract: lowercase everywhere'): slides writes students.yaml with username ALREADY lowercased (lab-build.yaml already lowercases before writing the tag file — the two must match byte-for-byte for the merge generator to join)." $v) }}
{{- end -}}
{{- $v -}}
{{- end -}}

{{/* appName doubles as: k8s object name, GHCR image repo leaf, and the Ingress
     hostname label — ONE identifier everywhere (D-026's "one slug everywhere"
     for tenants). EXACTLY matches slidedeck's own `labRepoName()`
     (${lab.slug}-${username}). Length-capped at 63 (adversarial review C-2):
     it is used as BOTH a k8s label value and a DNS label, both 63-char capped;
     an uncapped `<labSlug>-<username>` would silently produce an invalid
     Service selector / Ingress host past that length with no clear error. */}}
{{- define "lab-app.appName" -}}
{{- $labSlug := include "lab-app.labSlug" . -}}
{{- $username := include "lab-app.username" . -}}
{{- $name := printf "%s-%s" $labSlug $username -}}
{{- if gt (len $name) 63 -}}
{{ fail (printf "labSlug+username %q is %d chars, over the 63-char k8s label/DNS-label cap (labSlug=%q username=%q)." $name (len $name) $labSlug $username) }}
{{- end -}}
{{- $name -}}
{{- end -}}

{{- define "lab-app.namespace" -}}
lab-{{ include "lab-app.labSlug" . }}
{{- end -}}

{{- define "lab-app.host" -}}
{{ include "lab-app.appName" . }}.{{ .Values.appDomain }}
{{- end -}}

{{/* `repo` — the roster's authoritative `org/name` field, required + format-
     validated (same fail-loud pattern as labSlug/username/tag). Existed in
     the contract from round 1 onward as an "informational only" annotation
     — now load-bearing (adversarial review M-1, round 3): see
     `lab-app.image` below for why. */}}
{{- define "lab-app.repo" -}}
{{- $v := .Values.repo | default "" -}}
{{- if not (regexMatch "^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$" $v) -}}
{{ fail (printf "repo %q is missing, empty, or not a valid \"org/name\". Required: chart/templates/_helpers.tpl `lab-app.image` derives the GHCR pull ref from THIS field (adversarial review M-1), not from labSlug+username." $v) }}
{{- end -}}
{{- $v -}}
{{- end -}}

{{/* GHCR image ref (adversarial review B-2 — replaces Harbor for lab-app
     images; see README "Registry: GHCR, not Harbor").

     ADVERSARIAL REVIEW M-1 (round 3, CHANGED from rounds 1-2): this used to
     RECONSTRUCT the ref as `ua-mis/<labSlug>-<username>` (i.e.
     `lab-app.appName`), on the assumption that `lab-build.yaml`'s push
     target always equals that same string by convention. Round 3 removed
     the identity-assertion check that USED to enforce that convention in
     `lab-build.yaml` (correctly — B-3's check gated nothing an attacker
     couldn't already bypass with the H-2 fix in place, so keeping it added
     complexity without real security value). But that check was doing
     double duty: it was ALSO the only thing keeping the chart's
     RECONSTRUCTED ref in sync with what `lab-build.yaml` ACTUALLY pushed to
     (`ghcr.io/<lowercased github.repository>`). Once removed, a
     `students.yaml` row whose `repo` field didn't exactly match
     `<labSlug>-<username>` (a slides bug, a renamed repo, anything) would
     silently push a GREEN build to a package this chart would never derive
     the same ref for — a real image sitting in GHCR, an
     ImagePullBackOff pod pointed at a DIFFERENT (correctly-named but
     nonexistent) ref, with no error anywhere pointing at the mismatch. The
     failure mode degraded from "fail loud" (round 2's identity check) to
     "fail silent" (round 3 with no compensating fix).

     FIXED by deriving from `.Values.repo` (`lab-app.repo` above) — the
     roster's OWN authoritative `org/name` field, which is exactly what
     `github.repository` equals inside the student's CI run, lowercased the
     same way `lab-build.yaml` lowercases it before pushing. This can no
     longer drift: the chart now points at whatever slides ACTUALLY put in
     the roster, not a reconstruction that assumes it matches. `appName`
     (labSlug-username) remains authoritative for k8s OBJECT NAMES / the
     Ingress host — those still need the platform's own naming convention,
     independent of what the student's repo happens to be called — but is no
     longer used for the pull ref. */}}
{{- define "lab-app.image" -}}
ghcr.io/{{ include "lab-app.repo" . | lower }}:{{ include "lab-app.imageTag" . }}
{{- end -}}

{{/* Kyverno `disallow-latest-tag` is Enforce cluster-wide and lab-* namespaces
     are NOT in its exclude list (by design — see README), so `:latest` can
     never be used as a fallback. A student with no green CI run yet gets
     `:unreleased` — a deliberately non-existent tag: Kyverno admits the Pod
     (it's a real, non-latest tag), and it sits ImagePullBackOff (not
     admission-rejected) until their first successful push writes a real tag.
     STRICT allowlist (adversarial review B-4): `tag` originates from
     student-controlled CI output written into a git file this chart reads —
     an unvalidated value interpolated into `image:` unquoted is a YAML/pod-
     spec injection vector (a tag containing a newline could inject sibling
     keys). Only a short-or-long hex commit SHA, or empty (-> :unreleased), is
     accepted; anything else fails loudly instead of being trusted verbatim. */}}
{{- define "lab-app.imageTag" -}}
{{- if not .Values.tag -}}
unreleased
{{- else if regexMatch "^[a-f0-9]{7,64}$" .Values.tag -}}
{{ .Values.tag }}
{{- else -}}
{{ fail (printf "tag %q does not match ^[a-f0-9]{7,64}$ (a git commit SHA, lowercase hex) — refusing to interpolate an unvalidated, student-CI-controlled value into the pod spec. Empty/absent is fine (renders :unreleased)." .Values.tag) }}
{{- end -}}
{{- end -}}

{{- define "lab-app.labels" -}}
platform.capstone/component: lab
platform.capstone/lab-slug: {{ include "lab-app.labSlug" . | quote }}
{{- end -}}

{{/* withDatabase gating (adversarial review H-1 — see README "Contract:
     withDatabase"). NOT a `{{- define }}` helper used as `{{- if include ...
     }}` — a `define` block always returns non-empty STRING TEXT (even the
     text "false"), and Go templates treat any non-empty string as truthy, so
     `{{- if include "lab-app.withDatabase" . }}` would be ALWAYS true
     regardless of the actual value — a real Helm footgun. Every gate on this
     value therefore uses this EXACT inline expression directly:

       {{- if eq (toString .Values.withDatabase) "true" }}

     `toString` (sprig) normalizes whatever the ApplicationSet's goTemplate
     layer produced — a real YAML bool (`true`) OR (defensively, in case a
     given ArgoCD version's git-files generator stringifies scalars) the
     string "true" — to one canonical string, so the comparison is correct
     either way. Never write `{{- if .Values.withDatabase }}` directly: an
     ApplicationSet-supplied STRING "false" would be non-empty and therefore
     Go-template-truthy, silently inverting the gate for exactly the
     `with_database: false` labs this whole mechanism exists to protect. */}}
