# Post-merge triage — 2026-07-07 overnight batch (PR #253)

Overnight batch of 16 PRs landed on `main` around 07:12–07:24 CDT.
Sync surfaced a chain of latent bugs the agent's tests hadn't caught.
This doc records what broke, what we fixed, and what still needs a human.

## The 16 that landed

| PR   | What                                              |
| ---- | ------------------------------------------------- |
| #209 | Click-to-promote prod (workflow_dispatch)         |
| #239 | Backstage Harbor provisioner robot SealedSecret   |
| #240 | Promotion ladder — bump-staging on tag push       |
| #241 | Persistent swap-disable + zero-touch tenant claim |
| #242 | Multi-cluster ApplicationSet scaffolding (inert)  |
| #243 | Cilium mTLS + L7 policy (needs manual `helm`)     |
| #244 | OpenCost + custom pricing dashboard               |
| #245 | Vault 3-node Raft HA                              |
| #246 | SPIFFE/SPIRE workload identity baseline           |
| #247 | Velero + MinIO (dr-backup) node-local             |
| #248 | VPA right-sizing + Goldilocks visibility fix      |
| #249 | In-cluster DB tier (CNPG + MariaDB Galera + MinIO)|
| #250 | Supply-chain (cosign + syft + Kyverno policies)   |
| #251 | Observability (Tempo + Thanos + OTel + ntfy)      |
| #252 | Argo Rollouts + wizard toggle                     |
| #253 | Union merge to main                               |

## What broke, and the PRs that fixed each

| Bug                                                             | Fix PR |
| --------------------------------------------------------------- | ------ |
| `wizard-green-check` red on main — Jinja `progressiveDelivery` undefined in `compose_lib.py` | #254 |
| `platform-mariadb-cluster` sync-failed — user name `crossplane_provisioner` has an underscore (RFC 1123 invalid) | #255 |
| `thanos-query` CrashLoopBackOff — used `--store` flag removed in Thanos v0.36+ (replaced by `--endpoint`) | #256 |
| `dr-backup` bucket never created — the `minio-provision` Job's script comment said "add when Thanos lands" but never did | #257 |
| `thanos-store-gateway` blocked from MinIO by NetPol — `monitoring` ns not in the allow-list | #258 |
| MinIO on `mac-debian-01` unreachable from any pod — Cilium bound VXLAN to the wrong node IP after the power-outage reboot | #268 (workaround) |
| MinIO on `mac-debian-02` crash — hostPath dir owned root:root, kubelet's `fsGroup` chown is a silent no-op for hostPath | #269 |
| chown-data initContainer crash — dropped ALL caps + only added `CHOWN`; `chmod` needs `FOWNER` | #270 |

Plus a handful of debug PRs (#259, #261–#267) that added and later removed a
netshoot pod for cross-node probing — cleaned up in #268.

## The cross-node Cilium issue (the fun one)

After a power outage the night of 2026-07-06, `mac-debian-01` came back up but
Cilium on that node bound its VXLAN endpoint to the LAN IP (`10.237.171.14`)
instead of its Tailscale IP (`100.69.204.106`).

Root cause: kubelet on the Debian workers races with `tailscaled` at boot.
Kubelet started first, registered the node's `InternalIP` as the LAN address,
and Cilium built its tunnel table with that. The other nodes' Cilium agents
still had the pre-outage Tailscale IP cached. Result:

- Other nodes send VXLAN to `100.69.204.106:8472`. Tailscale accepts, kernel
  delivers, but Cilium on the receiving side isn't listening on that endpoint.
  Packets are dropped silently.
- `nc -zuv 100.69.204.106 8472` succeeds (UDP with no listener returns OK).
- `ping`, `traceroute`, and `curl` to any pod IP on `mac-debian-01` time out.
- MinIO's local readiness probe still passes (kubelet on the node itself),
  so ArgoCD reports the pod as `1/1 Healthy` — misleading.

Confirmed by scheduling a `nicolaka/netshoot` pod on both `mac-debian-02` and
`capstone-n1`. Both saw identical 100% packet loss + all-timeouts on traceroute.

## Current state (as of ~13:45 CDT)

- **CI on main:** green.
- **Vault HA:** healthy, 3-node.
- **CNPG + MariaDB:** still Progressing — needs the operator to write DB creds
  to Vault per `docs/operator/in-cluster-db-tier-runbook.md §2` before the
  cluster CRs can go Ready.
- **MinIO:** moved to `mac-debian-02`, up, but the provision Job is still
  seeing `dial tcp: i/o timeout` to the Service ClusterIP. Likely Endpoints
  not yet populated post-recreate — being watched.
- **Thanos / Grafana / kube-prometheus-stack:** blocked on MinIO. Will
  cascade green once the provision Job completes and buckets exist.
- **SPIRE:** `platform-spire` is Missing/SyncFailed — pre-upgrade Job's
  missing webhook. Not investigated yet.
- **`mac-debian-01`:** node is up (Tailscale connected, kubelet responding),
  Cilium is broken. Scheduler still considers it Ready — anything scheduled
  there is stranded on the pod overlay. Not cordoned.

## What we think should happen next

**Short term (needs kubectl / SSH, wait until operator is on-site):**

1. **Fix Cilium on `mac-debian-01`.** Restart the Cilium DaemonSet pod on
   that node. This alone may not fix it — the other nodes' Cilium agents
   also have stale tunnel table entries. Restart Cilium on all 6 nodes to
   be safe. Verify with `cilium status` and a cross-node pod-to-pod curl.
2. **Then either return MinIO to `mac-debian-01`** (its original home, per
   `pv-local.yaml`'s design comment) **or leave it on `mac-debian-02`** and
   update the doc comments. Data on the old `mac-debian-01` hostPath is
   empty and can be deleted.
3. **Cordon `mac-debian-01` while Cilium is broken** so nothing new lands
   there and gets stranded (`kubectl cordon mac-debian-01`).
4. **Restart or force a re-run of the SPIRE pre-upgrade Job** and confirm
   the webhook lands. If it doesn't, disable the pre-upgrade hook in the
   Helm values and rely on `platform-spire-crds` being applied first.
5. **Write the DB-tier Vault credentials** to unblock CNPG + MariaDB.

**Durable fix (needs an Ansible change):**

Pin kubelet's `--node-ip` to the Tailscale IP on the Debian workers so
Cilium can't race with tailscaled on boot. Options:

- Set `KUBELET_EXTRA_ARGS="--node-ip=100.69.x.x"` in the kubelet drop-in.
- Or add `After=tailscaled.service` + `Requires=tailscaled.service` to
  the kubelet unit so the kubelet doesn't start until Tailscale is up.

Both together is the belt-and-suspenders answer. Land this in
`ansible/roles/kubelet_join/` and re-run the playbook against all workers.

## Followups worth remembering

- The `minio-provision` Job's script had a stale `# TODO when Thanos lands`
  comment (#257 fixed the code but the comment shape ("add later, we
  promise") is a recurring failure mode — the overnight batch added Thanos
  without editing that TODO).
- The MinIO `statefulset.yaml` still has a wrong comment claiming kubelet
  `fsGroup` chowns hostPath mounts. Update that comment when someone
  touches the file next.
- The `pv-local.yaml` header still says "mac-debian-01 was picked
  arbitrarily" — either update to `mac-debian-02` or update after Cilium
  is fixed and MinIO returns to `mac-debian-01`.
- Kyverno policies (`require-limits`, `disallow-latest-tag`) are Audit
  mode but noisy — they catch every unresourced/tagged pod. Worth a pass
  over the platform manifests to satisfy them and clean up the alert
  stream, or a decision to move some policies to Enforce.
