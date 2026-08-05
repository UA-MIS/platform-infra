{{/*
Shared naming — defined ONCE here so namespace mode and studentApp mode can never
diverge on what "the lab's namespace" or "the student's app name" means.
*/}}

{{- define "lab-app.namespace" -}}
lab-{{ .Values.labSlug }}
{{- end -}}

{{/* GitHub usernames are already DNS-safe (alnum + single internal hyphens, no
     leading/trailing/double hyphen — GitHub's own username policy); lowercasing
     is the only normalization needed (see values.yaml "Username handling"). */}}
{{- define "lab-app.username" -}}
{{ .Values.username | lower }}
{{- end -}}

{{/* appName doubles as: k8s object name, Harbor image repo name (within the
     shared `labs` project), and the Ingress hostname label — ONE identifier
     everywhere, mirroring D-026's "one slug everywhere" for tenants. Also
     EXACTLY matches slidedeck's own `labRepoName()` (${lab.slug}-${username}),
     so the student's GitHub repo name, Harbor image name, and hostname prefix
     are all identical strings. */}}
{{- define "lab-app.appName" -}}
{{ .Values.labSlug }}-{{ include "lab-app.username" . }}
{{- end -}}

{{- define "lab-app.host" -}}
{{ include "lab-app.appName" . }}.{{ .Values.appDomain }}
{{- end -}}

{{/* Kyverno `disallow-latest-tag` is Enforce cluster-wide and lab-* namespaces are
     NOT in its exclude list (by design — see README), so `:latest` can never be
     used as a fallback. A student with no green CI run yet gets `:unreleased` — a
     deliberately non-existent tag: Kyverno admits the Pod (it's a real, non-latest
     tag), and it sits ImagePullBackOff (not admission-rejected) until their first
     successful push writes a real tag via labs/<labSlug>/tags/<username>.yaml. */}}
{{- define "lab-app.imageTag" -}}
{{- if .Values.tag -}}
{{ .Values.tag }}
{{- else -}}
unreleased
{{- end -}}
{{- end -}}

{{- define "lab-app.image" -}}
{{ .Values.harborHost }}/{{ .Values.harborProject }}/{{ include "lab-app.appName" . }}:{{ include "lab-app.imageTag" . }}
{{- end -}}

{{- define "lab-app.labels" -}}
platform.capstone/component: lab
platform.capstone/lab-slug: {{ .Values.labSlug }}
{{- end -}}
