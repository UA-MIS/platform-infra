#!/usr/bin/env bash
# Backstage WRITE-path semantics test — HOST-CLI variant (team-lead's minted-token form).
# Runs AS the backstage-writer IDENTITY via a minted audience=vault SA token + a
# port-forward to in-cluster Vault. Needs ONLY #109's SA backstage-vault-writer + the
# Vault role/policy backstage-writer (Step 1). NO new pod, NO root.
#
# WHY port-forward: Vault is ClusterIP + in-cluster TLS (no host ingress). The cert has
# a 127.0.0.1 IP SAN, so curl to https://127.0.0.1:8200 --cacert ca.crt validates.
# WHY minted token: `kubectl create token ... --audience=vault` issues the SA's JWT with
# audience=vault (the Vault role's bound audience) WITHOUT needing the projected-volume pod.
#
# Mirrors vaultClient.ts: login {jwt,role}->client_token; set=PATCH merge-patch {data:{k:v}}
# (404/405 -> POST create); delete=PATCH {data:{k:null}}. Proves non-destructive single-key.
#
# Usage:  ./backstage-writer-semantics-test.sh           (ctx defaults to admin@capstone)
set -euo pipefail
CTX="${KUBE_CONTEXT:-admin@capstone}"
P="secret/data/tenants/smoketest/dev/app"     # throwaway, in backstage-writer's tenants/* scope
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"; [ -n "${PF_PID:-}" ] && kill "$PF_PID" 2>/dev/null || true' EXIT

echo "==> extracting Vault CA (public) to a temp file"
kubectl --context "$CTX" -n vault get secret vault-server-tls -o jsonpath='{.data.ca\.crt}' | base64 -d > "$TMP/ca.crt"
[ -s "$TMP/ca.crt" ] || { echo "FAIL: empty CA"; exit 1; }

echo "==> minting audience=vault token for SA backstage-vault-writer (no pod)"
JWT="$(kubectl --context "$CTX" -n backstage create token backstage-vault-writer --audience=vault --duration=10m)"
[ -n "$JWT" ] || { echo "FAIL: could not mint SA token (does SA backstage-vault-writer exist? = #109 synced)"; exit 1; }

echo "==> port-forward vault svc -> 127.0.0.1:8200 (cert has the 127.0.0.1 SAN)"
kubectl --context "$CTX" -n vault port-forward svc/vault 8200:8200 >/dev/null 2>&1 &
PF_PID=$!; sleep 3
A="https://127.0.0.1:8200"; CA="$TMP/ca.crt"
c() { curl -sS --cacert "$CA" "$@"; }

echo "==> login as role=backstage-writer (minted audience=vault JWT)"
TOK="$(c --request POST --data "{\"jwt\":\"$JWT\",\"role\":\"backstage-writer\"}" \
       "$A/v1/auth/kubernetes/login" | sed -n 's/.*"client_token":"\([^"]*\)".*/\1/p')"
[ -n "$TOK" ] || { echo "FAIL: login rejected — check role/SA binding/audience"; exit 1; }
H="-H X-Vault-Token:$TOK"
patch(){ c $H -H 'Content-Type: application/merge-patch+json' --request PATCH --data "{\"data\":{\"$1\":$2}}" "$A/v1/$P" >/dev/null; }
post(){  c $H --request POST --data "{\"data\":{\"$1\":$2}}" "$A/v1/$P" >/dev/null; }
get(){   c $H "$A/v1/$P"; }

echo "==> seed A+B (POST create on fresh path)"
post A '"a1"'; ( patch B '"b1"' 2>/dev/null || post B '"b1"' )
echo "==> patch C (merge-patch add)"
patch C '"c1"'
j="$(get)"; echo "$j" | grep -q '"A":"a1"' && echo "$j" | grep -q '"B":"b1"' && echo "$j" | grep -q '"C":"c1"' \
  || { echo "FAIL after add: expected A,B,C — got: $j"; exit 1; }
echo "    OK: A,B,C present"
echo "==> delete B via merge-patch null"
patch B null
j="$(get)"
echo "$j" | grep -q '"B":' && { echo "FAIL: B survived null-delete — got: $j"; exit 1; }
echo "$j" | grep -q '"A":"a1"' && echo "$j" | grep -q '"C":"c1"' \
  || { echo "FAIL: A/C lost during B delete (DESTRUCTIVE) — got: $j"; exit 1; }
echo "    OK: A,C survive; B gone (non-destructive confirmed)"
echo "NOTE: throwaway path left behind (writer has no metadata delete — least priv). Root cleanup:"
echo "      vault kv metadata delete secret/tenants/smoketest/dev/app"
echo "SEMANTICS-TEST: PASS"
