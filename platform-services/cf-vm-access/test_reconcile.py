#!/usr/bin/env python3
# =============================================================================
# Unit tests for the cf-vm-access merge logic (ADR-038).
#
# WHY THESE EXIST. The tunnel config is a WHOLE-LIST PUT against the one config
# that carries every public platform hostname — portal, Harbor, ArgoCD, the
# boards, the slides. A bad merge does not degrade one tenant; it takes the whole
# platform offline at once. That risk is entirely in `plan_ingress`, which is
# deliberately pure (no I/O) so it can be driven exhaustively here with no
# Cloudflare token and no cluster.
#
# Run:  python3 -m unittest discover -s platform-services/cf-vm-access -v
# =============================================================================
import json
import unittest

import reconcile

DOMAIN = "uamishub.com"

# A realistic stand-in for the live platform tunnel config: apex hosts, a
# capstone-level wildcard, and the load-bearing catch-all last.
PLATFORM_RULES = [
    {"hostname": "uamishub.com", "service": "http://traefik.kube-system:80"},
    {"hostname": "slides.uamishub.com", "service": "http://traefik.kube-system:80"},
    {"hostname": "*.capstone.uamishub.com", "service": "http://traefik.kube-system:80"},
    {"service": "http_status:404"},                      # <- the catch-all
]


def svc(team, app, ns, emails="a@x.edu", access_label=True, team_label=True):
    meta = {"name": f"{app}-ssh", "namespace": ns, "labels": {}, "annotations": {}}
    if team_label:
        meta["labels"]["platform.capstone/team"] = team
    if access_label:
        meta["labels"]["platform.capstone/access"] = "ssh"
    if emails is not None:
        meta["annotations"]["platform.capstone/ssh-access-emails"] = emails
    return {"metadata": meta}


class Base(unittest.TestCase):
    def setUp(self):
        reconcile.DOMAIN = DOMAIN
        reconcile.ALLOW_EMPTY = False

    def tenants(self, *services):
        return reconcile.tenants_from_service_list({"items": list(services)})


class TestNaming(Base):
    def test_hostname_is_single_label_under_the_apex(self):
        t = self.tenants(svc("paper-papas", "storefront", "paper-papas-vm-prod"))[0]
        self.assertEqual(t["hostname"], "paper-papas-ssh.uamishub.com")
        # exactly one label before the domain — this is the TLS-wildcard constraint
        label = t["hostname"][: -len(f".{DOMAIN}")]
        self.assertNotIn(".", label)

    def test_origin_points_at_the_app_service_not_the_team(self):
        t = self.tenants(svc("paper-papas", "storefront", "paper-papas-vm-prod"))[0]
        self.assertEqual(
            t["service"],
            "ssh://storefront-ssh.paper-papas-vm-prod.svc.cluster.local:22")

    def test_team_falls_back_to_namespace_when_label_absent(self):
        t = self.tenants(svc("ignored", "app", "blue-jays-vm-prod", team_label=False))[0]
        self.assertEqual(t["team"], "blue-jays")
        self.assertEqual(t["hostname"], "blue-jays-ssh.uamishub.com")

    def test_team_slug_containing_vm_is_not_truncated_early(self):
        # rindex, not index: a team literally named "vm-club" must survive.
        t = self.tenants(svc("x", "app", "vm-club-vm-prod", team_label=False))[0]
        self.assertEqual(t["team"], "vm-club")

    def test_emails_split_on_comma_and_semicolon(self):
        t = self.tenants(svc("t", "a", "t-vm-prod", emails="a@x.edu; b@x.edu ,c@x.edu"))[0]
        self.assertEqual(t["emails"], ["a@x.edu", "b@x.edu", "c@x.edu"])

    def test_missing_emails_yields_empty_list_not_a_crash(self):
        t = self.tenants(svc("t", "a", "t-vm-prod", emails=None))[0]
        self.assertEqual(t["emails"], [])

    def test_non_ssh_service_is_skipped(self):
        items = [{"metadata": {"name": "storefront", "namespace": "t-vm-prod"}}]
        self.assertEqual(reconcile.tenants_from_service_list({"items": items}), [])

    def test_two_services_resolving_to_one_hostname_is_refused(self):
        with self.assertRaises(RuntimeError):
            self.tenants(svc("dup", "a", "dup-vm-prod"),
                         svc("dup", "b", "dup-vm-dev"))


class TestManagedDiscriminator(Base):
    def test_our_own_rule_matches(self):
        self.assertTrue(reconcile.is_managed_rule(
            {"hostname": "t-ssh.uamishub.com", "service": "ssh://x.y.svc:22"}))

    def test_http_rule_ending_in_ssh_is_not_managed(self):
        # both halves must match — an HTTP origin is never ours
        self.assertFalse(reconcile.is_managed_rule(
            {"hostname": "t-ssh.uamishub.com", "service": "http://traefik:80"}))

    def test_platform_hostnames_are_not_managed(self):
        for r in PLATFORM_RULES:
            self.assertFalse(reconcile.is_managed_rule(r), r)

    def test_two_label_host_is_not_managed(self):
        self.assertFalse(reconcile.is_managed_rule(
            {"hostname": "a-ssh.capstone.uamishub.com", "service": "ssh://x:22"}))

    def test_other_domain_is_not_managed(self):
        self.assertFalse(reconcile.is_managed_rule(
            {"hostname": "t-ssh.evil.com", "service": "ssh://x:22"}))


class TestMerge(Base):
    def test_inserts_before_the_catch_all_and_preserves_everything(self):
        tenants = self.tenants(svc("paper-papas", "storefront", "paper-papas-vm-prod"))
        new, notes = reconcile.plan_ingress(PLATFORM_RULES, tenants)
        self.assertIsNotNone(new, notes)
        self.assertEqual(new[0], {
            "hostname": "paper-papas-ssh.uamishub.com",
            "service": "ssh://storefront-ssh.paper-papas-vm-prod.svc.cluster.local:22"})
        # every original rule survives, in order, immediately after ours
        self.assertEqual(new[1:], PLATFORM_RULES)
        # and the last rule is still the catch-all
        self.assertNotIn("hostname", new[-1])

    def test_wildcard_rule_survives_verbatim(self):
        tenants = self.tenants(svc("t", "a", "t-vm-prod"))
        new, _ = reconcile.plan_ingress(PLATFORM_RULES, tenants)
        self.assertIn({"hostname": "*.capstone.uamishub.com",
                       "service": "http://traefik.kube-system:80"}, new)

    def test_is_idempotent(self):
        tenants = self.tenants(svc("t", "a", "t-vm-prod"))
        once, _ = reconcile.plan_ingress(PLATFORM_RULES, tenants)
        twice, _ = reconcile.plan_ingress(once, tenants)
        self.assertEqual(once, twice)

    def test_multiple_tenants_are_ordered_deterministically(self):
        tenants = self.tenants(svc("zeta", "a", "zeta-vm-prod"),
                               svc("alpha", "b", "alpha-vm-prod"))
        new, _ = reconcile.plan_ingress(PLATFORM_RULES, tenants)
        self.assertEqual([r["hostname"] for r in new[:2]],
                         ["alpha-ssh.uamishub.com", "zeta-ssh.uamishub.com"])

    def test_teardown_removes_only_the_departed_tenant(self):
        two = self.tenants(svc("keep", "a", "keep-vm-prod"),
                           svc("gone", "b", "gone-vm-prod"))
        populated, _ = reconcile.plan_ingress(PLATFORM_RULES, two)
        one = self.tenants(svc("keep", "a", "keep-vm-prod"))
        after, notes = reconcile.plan_ingress(populated, one)
        hosts = [r.get("hostname") for r in after]
        self.assertIn("keep-ssh.uamishub.com", hosts)
        self.assertNotIn("gone-ssh.uamishub.com", hosts)
        self.assertEqual(after[1:], PLATFORM_RULES)
        self.assertTrue(any("DEL" in n for n in notes), notes)

    def test_full_teardown_back_to_the_original_config(self):
        tenants = self.tenants(svc("t", "a", "t-vm-prod"))
        populated, _ = reconcile.plan_ingress(PLATFORM_RULES, tenants)
        empty, _ = reconcile.plan_ingress(populated, [], allow_empty=True)
        self.assertEqual(empty, PLATFORM_RULES)

    def test_unrelated_rules_are_preserved_byte_identical(self):
        exotic = [
            {"hostname": "weird.uamishub.com", "service": "http://x:1",
             "originRequest": {"noTLSVerify": True, "connectTimeout": "30s"}},
        ] + PLATFORM_RULES
        tenants = self.tenants(svc("t", "a", "t-vm-prod"))
        new, _ = reconcile.plan_ingress(exotic, tenants)
        self.assertEqual(json.dumps(new[1:]), json.dumps(exotic))


class TestGuards(Base):
    def test_guard_trips_when_the_catch_all_is_missing(self):
        no_catchall = [r for r in PLATFORM_RULES if r.get("hostname")]
        tenants = self.tenants(svc("t", "a", "t-vm-prod"))
        new, notes = reconcile.plan_ingress(no_catchall, tenants)
        self.assertIsNone(new)
        self.assertTrue(any("REFUSE" in n and "catch-all" in n for n in notes), notes)

    def test_guard_trips_when_the_catch_all_is_not_last(self):
        misordered = [PLATFORM_RULES[-1]] + PLATFORM_RULES[:-1]
        tenants = self.tenants(svc("t", "a", "t-vm-prod"))
        new, notes = reconcile.plan_ingress(misordered, tenants)
        self.assertIsNone(new)
        self.assertTrue(any("REFUSE" in n for n in notes), notes)

    def test_guard_trips_on_an_empty_ingress_list(self):
        tenants = self.tenants(svc("t", "a", "t-vm-prod"))
        new, notes = reconcile.plan_ingress([], tenants)
        self.assertIsNone(new)
        self.assertTrue(any("EMPTY ingress" in n for n in notes), notes)

    def test_guard_refuses_mass_delete_when_discovery_comes_back_empty(self):
        tenants = self.tenants(svc("t", "a", "t-vm-prod"))
        populated, _ = reconcile.plan_ingress(PLATFORM_RULES, tenants)
        new, notes = reconcile.plan_ingress(populated, [])       # allow_empty=False
        self.assertIsNone(new)
        self.assertTrue(any("desired state is EMPTY" in n for n in notes), notes)

    def test_empty_desired_with_no_managed_rules_is_a_clean_noop(self):
        new, _ = reconcile.plan_ingress(PLATFORM_RULES, [])
        self.assertEqual(new, PLATFORM_RULES)

    def test_a_config_that_is_only_a_catch_all_still_works(self):
        only = [{"service": "http_status:404"}]
        tenants = self.tenants(svc("t", "a", "t-vm-prod"))
        new, _ = reconcile.plan_ingress(only, tenants)
        self.assertEqual(len(new), 2)
        self.assertNotIn("hostname", new[-1])


class TestPlanNotes(Base):
    """The plan SUMMARY must describe what the write actually does.

    Regression guard for a defect found against the live v23 tunnel config: the
    summary compared whole dicts, but Cloudflare stores every rule decorated with
    fields we never send (`id`, and an empty `originRequest: {}`). A live, healthy,
    unchanged tenant therefore compared unequal to the bare rule we build, and the
    plan announced `ADD` and `DEL <host> (tenant gone)` for it at the same time.

    The write was never wrong. The go-live dry run — the one artefact the operator
    doc tells a human to read before flipping DRY_RUN off — was.
    """

    # A rule exactly as Cloudflare hands it back, decorated the way the live tunnel
    # decorates it. This is the whole point of the fixture: it is NOT `==` to ours.
    def live_rule(self, host, service, rule_id="1"):
        return {"hostname": host, "id": rule_id,
                "originRequest": {}, "service": service}

    def test_unchanged_live_tenant_reports_keep_and_never_tenant_gone(self):
        tenants = self.tenants(svc("paper-papas", "storefront", "paper-papas-vm-prod"))
        live = [self.live_rule(
            "paper-papas-ssh.uamishub.com",
            "ssh://storefront-ssh.paper-papas-vm-prod.svc.cluster.local:22")]
        new, notes = reconcile.plan_ingress(live + PLATFORM_RULES, tenants)
        self.assertIsNotNone(new, notes)
        body = "\n".join(notes)
        self.assertIn("keep paper-papas-ssh.uamishub.com", body)
        self.assertNotIn("tenant gone", body)
        self.assertNotIn("ADD ", body)

    def test_the_rule_survives_the_write_even_though_the_note_said_keep(self):
        # "keep" must not be mistaken for "we skipped it" — the rule is rebuilt.
        tenants = self.tenants(svc("paper-papas", "storefront", "paper-papas-vm-prod"))
        live = [self.live_rule(
            "paper-papas-ssh.uamishub.com",
            "ssh://storefront-ssh.paper-papas-vm-prod.svc.cluster.local:22")]
        new, _ = reconcile.plan_ingress(live + PLATFORM_RULES, tenants)
        self.assertEqual(new[0], {
            "hostname": "paper-papas-ssh.uamishub.com",
            "service": "ssh://storefront-ssh.paper-papas-vm-prod.svc.cluster.local:22"})
        self.assertEqual(new[1:], PLATFORM_RULES)

    def test_a_genuinely_departed_tenant_still_reports_tenant_gone(self):
        # The alarm must still fire when it is real, or the fix has broken teardown.
        tenants = self.tenants(svc("paper-papas", "storefront", "paper-papas-vm-prod"))
        live = [
            self.live_rule("paper-papas-ssh.uamishub.com",
                           "ssh://storefront-ssh.paper-papas-vm-prod.svc.cluster.local:22"),
            self.live_rule("blue-jays-ssh.uamishub.com",
                           "ssh://app-ssh.blue-jays-vm-prod.svc.cluster.local:22", "2"),
        ]
        _, notes = reconcile.plan_ingress(live + PLATFORM_RULES, tenants)
        body = "\n".join(notes)
        self.assertIn("DEL  blue-jays-ssh.uamishub.com (tenant gone)", body)
        self.assertNotIn("DEL  paper-papas-ssh.uamishub.com", body)

    def test_a_repointed_tenant_reports_move_not_add_plus_delete(self):
        # Same hostname, different origin (e.g. the app was renamed). That is one
        # re-point, not a delete plus an add of the same host.
        tenants = self.tenants(svc("paper-papas", "newapp", "paper-papas-vm-prod"))
        live = [self.live_rule(
            "paper-papas-ssh.uamishub.com",
            "ssh://oldapp-ssh.paper-papas-vm-prod.svc.cluster.local:22")]
        _, notes = reconcile.plan_ingress(live + PLATFORM_RULES, tenants)
        body = "\n".join(notes)
        self.assertIn("MOVE paper-papas-ssh.uamishub.com", body)
        self.assertNotIn("tenant gone", body)

    def test_a_brand_new_tenant_still_reports_add(self):
        tenants = self.tenants(svc("paper-papas", "storefront", "paper-papas-vm-prod"))
        _, notes = reconcile.plan_ingress(PLATFORM_RULES, tenants)
        self.assertIn("ADD  paper-papas-ssh.uamishub.com", "\n".join(notes))


if __name__ == "__main__":
    unittest.main(verbosity=2)
