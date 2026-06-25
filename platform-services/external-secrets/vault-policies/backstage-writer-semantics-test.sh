#!/usr/bin/env bash
# Backstage WRITE-path semantics test — HOST-CLI (minted-token form). TWO identities:
#   WRITER = SA backstage-vault-writer -> Vault role `backstage-writer` (create/update/patch,
#            NO read by design) — does the POSTs/PATCHes.
#   READER = SA external-secrets       -> Vault role `external-secrets` (external-secrets-ro,
#            read on secret/data/tenants/*) — does the GET verifications.
# WHY two: backstage-writer has NO read (least privilege), so it CANNOT verify its own writes
# — the GET would (correctly) 403. We verify via the RO identity (the real ESO read path),
# never root. This mirrors production: the writer writes, ESO reads.
#
# Proves NON-DESTRUCTIVE single-key semantics (mirrors vaultClient.ts): set = PATCH merge-patch
# {data:{k:v}} (404/405 -> POST create); delete = PATCH {data:{k:null}}.
#   seed A+B -> patch C -> (RO) assert A,B,C -> delete B via null -> (RO) assert A,C survive & B gone.
# Every HTTP call is status-checked (curl -sS exits 0 on a 403 body — so a silent write-403
# would otherwise masquerade as success; we assert 2xx explicitly).
#
# PREREQS: Vault role `backstage-writer` (backstage-role.sh) + `external-secrets` (eso-role.sh,
# already live) + SAs backstage-vault-writer/backstage and external-secrets/external-secrets.
# Usage:  ./backstage-writer-semantics-test.sh        (KUBE_CONTEXT defaults to admin@capstone)
set -euo pipefail
CTX="${KUBE_CONTEXT:-admin@capstone}"
P="secret/data/tenants/smoketest/dev/app"     # throwaway, in tenants/* scope (both roles allow)
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"; [ -n "${PF_PID:-}" ] && kill "$PF_PID" 2>/dev/null || true' EXIT

echo "==> extracting Vault CA"
kubectl --context "$CTX" -n vault get secret vault-server-tls -o jsonpath='{.data.ca\.crt}' | base64 -d > "$TMP/ca.crt"
[ -s "$TMP/ca.crt" ] || { echo "FAIL: empty CA"; exit 1; }
CA="$TMP/ca.crt"

echo "==> minting audience=vault tokens (WRITER backstage-vault-writer, READER external-secrets)"
WJWT="$(kubectl --context "$CTX" -n backstage        create token backstage-vault-writer --audience=vault --duration=10m)"
RJWT="$(kubectl --context "$CTX" -n external-secrets create token external-secrets       --audience=vault --duration=10m)"
[ -n "$WJWT" ] || { echo "FAIL: no writer SA token (SA backstage-vault-writer exists? = #109 synced)"; exit 1; }
[ -n "$RJWT" ] || { echo "FAIL: no reader SA token (SA external-secrets exists?)"; exit 1; }

echo "==> port-forward vault svc -> 127.0.0.1:8200 (cert has the 127.0.0.1 SAN)"
kubectl --context "$CTX" -n vault port-forward svc/vault 8200:8200 >/dev/null 2>&1 &
PF_PID=$!; sleep 3
A="https://127.0.0.1:8200"

# login <jwt> <role> -> echoes client_token (fails loudly on rejection)
login() {
  body="$(curl -sS --cacert "$CA" -X POST --data "{\"jwt\":\"$1\",\"role\":\"$2\"}" "$A/v1/auth/kubernetes/login")"
  t="$(printf '%s' "$body" | sed -n 's/.*"client_token":"\([^"]*\)".*/\1/p')"
  [ -n "$t" ] || { echo "FAIL: login rejected for role $2: $body" >&2; exit 1; }
  printf '%s' "$t"
}
# code <token> <method> <url> [curl-args...] -> prints HTTP code to stdout, body to $TMP/body.
# Never exits — caller decides. (curl -sS exits 0 even on 403, so we read the CODE explicitly.)
code() {
  tok="$1"; m="$2"; url="$3"; shift 3
  curl -sS --cacert "$CA" -o "$TMP/body" -w '%{http_code}' -H "X-Vault-Token:$tok" -X "$m" "$@" "$url"
}
# req = code + assert 2xx (else FAIL loudly); prints body on success.
req() {
  c="$(code "$@")"
  case "$c" in 2*) cat "$TMP/body";; *) echo "FAIL: $2 $3 -> HTTP $c: $(cat "$TMP/body")" >&2; exit 1;; esac
}

WT="$(login "$WJWT" backstage-writer)"
RT="$(login "$RJWT" external-secrets)"
echo "    login OK: writer=backstage-writer, reader=external-secrets"

# set_key: PATCH merge-patch (mirrors vaultClient); if PATCH 404/405s (fresh path), POST create.
set_key()  {
  c="$(code "$WT" PATCH "$A/v1/$P" -H 'Content-Type: application/merge-patch+json' --data "{\"data\":{\"$1\":$2}}")"
  case "$c" in
    2*) : ;;
    404|405) req "$WT" POST "$A/v1/$P" --data "{\"data\":{\"$1\":$2}}" >/dev/null ;;
    *) echo "FAIL: PATCH set $1 -> HTTP $c: $(cat "$TMP/body")" >&2; exit 1 ;;
  esac
}
create()   { req "$WT" POST  "$A/v1/$P" --data "{\"data\":{\"$1\":$2}}" >/dev/null; }
del_key()  { req "$WT" PATCH "$A/v1/$P" -H 'Content-Type: application/merge-patch+json' --data "{\"data\":{\"$1\":null}}" >/dev/null; }
read_data(){ req "$RT" GET  "$A/v1/$P"; }   # via the RO identity

echo "==> WRITER: seed A+B (create), patch C"
create A '"a1"'
set_key B '"b1"'
set_key C '"c1"'
echo "==> READER: assert A,B,C present"
j="$(read_data)"
echo "$j" | grep -q '"A":"a1"' && echo "$j" | grep -q '"B":"b1"' && echo "$j" | grep -q '"C":"c1"' \
  || { echo "FAIL after add: expected A,B,C — got: $j"; exit 1; }
echo "    OK: A,B,C present"
echo "==> WRITER: delete B via merge-patch null"
del_key B
echo "==> READER: assert A,C survive; B gone"
j="$(read_data)"
echo "$j" | grep -q '"B":' && { echo "FAIL: B survived null-delete — got: $j"; exit 1; }
echo "$j" | grep -q '"A":"a1"' && echo "$j" | grep -q '"C":"c1"' \
  || { echo "FAIL: A/C lost during B delete (DESTRUCTIVE) — got: $j"; exit 1; }
echo "    OK: A,C survive; B gone (non-destructive confirmed)"
echo "==> AUDIT (final RO read via external-secrets-ro, .data only):"
printf '%s\n' "$j" | sed -n 's/.*\("data":{[^}]*}\).*/    \1/p'
echo "NOTE: throwaway path left behind (writer has no metadata delete). Root cleanup:"
echo "      vault kv metadata delete secret/tenants/smoketest/dev/app"
echo "SEMANTICS-TEST: PASS"
