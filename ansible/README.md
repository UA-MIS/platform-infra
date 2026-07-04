# Debian Mac-Mini worker onboarding (Ansible)

Turns a fresh **Debian 13 (trixie, kernel 6.12)** Late-2014 Mac Mini (`Macmini7,1`)
into a **Ready Kubernetes worker** in the existing **Talos** cluster. These Macs
cannot boot Talos v1.13.4 (a Talos-build-specific boot hang; Debian boots fine on
the same 6.12 kernel, Broadcom `tg3` NIC works), so they run Debian and join the
cluster with the **standard Kubernetes TLS bootstrap** flow instead of `kubeadm`
(Talos has no kubeadm).

**The full operator procedure, prerequisites, validation and rollback live in
[`docs/operator/debian-worker-onboarding.md`](../docs/operator/debian-worker-onboarding.md).**
Read that first. This README is the quick reference.

## Layout

```
ansible/
  ansible.cfg
  site.yml                      # the play (common -> hardening -> containerd -> tailscale -> kubelet_join)
  Makefile                      # syntax/lint/check/run + read-only cluster-fact helpers
  inventory/
    hosts.example.ini           # copy to hosts.ini
    group_vars/
      mac_workers.yml           # non-secret defaults, all read from the live cluster
      secrets.example.yml       # copy to secrets.yml, ansible-vault encrypt
  roles/
    common/                     # base pkgs, kernel modules, sysctl, swap off, time sync
    hardening/                  # key-only SSH, unattended-upgrades, disable services, (opt) nftables
    containerd/                 # CRI runtime, SystemdCgroup, pause image, CNI dirs
    tailscale/                  # join the tailnet -> stable 100.x node IP
    kubelet_join/               # TLS-bootstrap the kubelet; ships the cluster CA
```

## Quick start

```bash
cd ansible
cp inventory/hosts.example.ini inventory/hosts.ini            # set ansible_host + kube_node_name
cp inventory/group_vars/secrets.example.yml inventory/group_vars/secrets.yml
$EDITOR inventory/group_vars/secrets.yml                       # bootstrap token + tailscale key
ansible-vault encrypt inventory/group_vars/secrets.yml

make syntax                                                   # validate
make check LIMIT=mac-debian-01                                # dry run
make run   LIMIT=mac-debian-01                                # onboard the first box
```

Then complete the **operator cluster-write steps** (mint token BEFORE the run;
apply the pool label AFTER) — see the runbook.

## The two things the operator must produce before the first run

1. A **bootstrap-token Secret** in `kube-system` (`bootstrap.kubernetes.io/token`,
   `auth-extra-groups=system:bootstrappers:nodes`). Its `<id>.<secret>` goes into
   `kubelet_bootstrap_token`.
2. A **reusable, pre-approved Tailscale auth key** (tailnet `taile5d412.ts.net`),
   into `tailscale_authkey`.

Exact commands: see the runbook prerequisites section.
