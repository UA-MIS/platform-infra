# slides-vault-ca — the platform Vault CA, in namespace `slides`

Materializes Secret **`vault-ca`** (key **`ca.crt`**) in ns **`slides`**.

## Why

The slides app (`UA-MIS/slidedeck`) writes per-student lab database credentials
into Vault over HTTPS. Vault's server certificate is issued by the platform's own
private CA (`CN=capstone-platform-ca`, self-signed), so without that CA in its
trust store the app cannot verify the connection — it must either fail or run
with TLS verification disabled.

This is the **read side's** counterpart. `platform-services/lab-hosting/chart/
templates/externalsecret.yaml` reads those credentials back out of Vault at
`labs/<slug>/<user>`; this Secret is part of what lets slides put them there in
the first place. The Vault-side identity (policy + k8s-auth role) is
`../external-secrets/vault-policies/slides-labs-writer-role.sh`; wiring the
slides Deployment to present it is a slidedeck-repo change, tracked there.

Landing this is **non-breaking**: the slides Deployment mounts it at
`/var/run/secrets/vault-ca` with `optional: true`, so the app runs today without
it and picks it up on its next restart.

## Why a committed manifest and not an ExternalSecret

**A CA certificate is public key material.** There is no confidentiality to
protect and nothing here an attacker could learn. This is already the platform's
established pattern for this exact problem — the same CA is committed in three
other places, whose own comment states it plainly ("The CA cert is PUBLIC — NOT
secret material — so it is git-safe"):

- `platform-services/crossplane/config/vault-ca-configmap.yaml` (provider-vault +
  the `vault-push` SecretStore's `caProvider`)
- `platform-services/arc/platform-ca-configmap.yaml`
- `platform-services/crossplane/apis/composition.yaml` (per-tenant drop)

Two ESO-native alternatives were evaluated and rejected:

| option | why not |
| --- | --- |
| ESO **Kubernetes-provider** `SecretStore` in ns `slides` reading `vault-server-tls` from ns `vault` | ESO requires the store's identity to hold `get`+`list`+`watch` on `secrets` in the SOURCE namespace, and RBAC cannot scope `list`/`watch` to a single `resourceName`. That would grant a slides-namespace ServiceAccount the ability to enumerate and read **every** Secret in ns `vault` — which today holds `vault-transit-unseal-token` (the auto-unseal transit token) and `vault-unsealer-ca`. Trading a public certificate for read access to the unseal credential is a bad trade. It would also be the first use of ESO's Kubernetes provider anywhere in this repo (every existing store is `provider.vault`). |
| Stage the CA into Vault at `secret/platform/vault-ca`, read it back via the existing `vault-backend` ClusterSecretStore | Workable, and it reuses machinery that already exists — but it is **strictly worse than this file**: the copy in Vault would also be a manual snapshot that does not track CA rotation, so it buys no freshness while adding an operator write and a second copy to keep straight. |

A reflector/replicator (emberstack, kubernetes-replicator) or a Kyverno
`generate`+`clone` rule would give genuine auto-distribution, but **none is
installed in this cluster** (verified live) — adopting a new controller to copy
one public file is not proportionate. The right long-term fix is cert-manager
**trust-manager** `Bundle`, already recorded as the post-demo TODO in
`vault-ca-configmap.yaml`; when that lands it should replace all four committed
copies at once, including this one.

A **Secret** rather than a ConfigMap (unlike the crossplane/arc copies) because
the consumer mounts it as a `secret:` volume — a ConfigMap volume source would
not satisfy that mount.

## Ownership

Namespace `slides` is created and owned by the separate `slidedeck` Application
(source repo `UA-MIS/slidedeck`, path `deploy/`). Exactly like
`platform-services/lab-db/`, this directory ships **no** Namespace object and
pins `namespace: slides` explicitly, which overrides the platform-services
appset template's neutral `kube-system` destination.

`vault-ca` does not exist in ns `slides` today (verified live) and the slidedeck
repo only *mounts* it, never creates it — so there is exactly one owner. If
slidedeck ever ships its own copy, `vault-ca` becomes dual-owned and ArgoCD will
raise a `SharedResourceWarning`; delete one side if that happens.

Deployed as Application `platform-svc-slides-vault-ca` by
`applicationsets/platform-services-appset.yaml`'s directory generator — merging
is the deploy, no `kubectl apply`.

## Drift

The committed PEM was verified byte-identical (DER sha256 match) to `ca.crt` in
Secret `vault-server-tls`, ns `vault` — the same key the `vault-backend`
ClusterSecretStore's `caProvider` already references — at authoring time. The
cert is self-signed with `notAfter 2036-06-15`, so rotation is not expected on
any near horizon.

**If the Vault server CA is ever rotated, this file goes stale** and must be
re-committed alongside the three copies listed above. Check with:

```sh
diff <(kubectl -n vault get secret vault-server-tls -o jsonpath='{.data.ca\.crt}' | base64 -d) \
     <(yq -r '.stringData."ca.crt"' platform-services/slides-vault-ca/secret.yaml)
```

## Verification performed

- `kubectl kustomize platform-services/slides-vault-ca` renders one Secret,
  `vault-ca`, ns `slides`, key `ca.crt`.
- `kubectl apply --dry-run=server` against the live cluster: `secret/vault-ca
  created (server dry run)`.
- Source confirmed live: `vault-server-tls` in ns `vault` is
  `kubernetes.io/tls` and carries `ca.crt` (plus `tls.crt`/`tls.key`), and the
  `vault-backend` ClusterSecretStore's `caProvider` points at exactly that
  `{name: vault-server-tls, namespace: vault, key: ca.crt, type: Secret}`.
