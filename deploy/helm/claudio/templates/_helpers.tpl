{{- define "claudio.name" -}}
{{- .Chart.Name -}}
{{- end -}}

{{- define "claudio.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "claudio.labels" -}}
app.kubernetes.io/name: {{ include "claudio.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "claudio.selectorLabels" -}}
app.kubernetes.io/name: {{ include "claudio.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* The claim the pod mounts: the one the chart makes, or the one the operator brought */}}
{{- define "claudio.claim" -}}
{{- default (include "claudio.fullname" .) .Values.persistence.existingClaim -}}
{{- end -}}

{{/* Name of the Secret holding the API token, or empty when the mode needs none */}}
{{- define "claudio.tokenSecret" -}}
{{- if eq .Values.auth.mode "token" -}}
{{- default (printf "%s-auth" (include "claudio.fullname" .)) .Values.auth.token.existingSecret -}}
{{- end -}}
{{- end -}}

{{/* Name of the Secret holding CLAUDIO_SECRET_KEY, or empty when none was given */}}
{{- define "claudio.secretKeySecret" -}}
{{- if .Values.secretKey.existingSecret -}}
{{- .Values.secretKey.existingSecret -}}
{{- else if .Values.secretKey.value -}}
{{- printf "%s-secret-key" (include "claudio.fullname" .) -}}
{{- end -}}
{{- end -}}
