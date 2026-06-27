/*
 * Config schema for the capstone secrets capability (M3, ESO+Vault model — ADR-030 B1).
 * Declaring it here makes `capstone.secrets.*` a known, validated config section (no "unknown
 * key" warnings) and documents each value. All optional — sealCore falls back to sensible
 * defaults (see readSecretsConfig in src/sealCore.ts).
 */
export interface Config {
  capstone?: {
    /**
     * Harbor provisioning for the capstone:harbor-onboard scaffolder action (creates the
     * team's Harbor project + OIDC Developer mapping at scaffold time). Authenticates with
     * a DEDICATED least-privilege provisioner robot (project-create + member-add only) —
     * NOT the full harbor-admin account. The deploy materializes username/secret into the
     * backstage namespace (e.g. via ESO/SealedSecret); they are NOT committed.
     */
    harbor?: {
      /**
       * Harbor core base URL (no trailing slash needed).
       * Default: http://harbor-core.harbor.svc:80 (in-cluster service).
       * @visibility backend
       */
      baseUrl?: string;
      /**
       * Provisioner robot username (e.g. `robot$capstone-provisioner`). REQUIRED — the
       * action fails closed rather than calling Harbor unauthenticated.
       * @visibility secret
       */
      username?: string;
      /**
       * Provisioner robot secret. REQUIRED.
       * @visibility secret
       */
      secret?: string;
      /**
       * OIDC group-name prefix; the mapped Harbor group is `<oidcGroupPrefix>:<team>`
       * (group_type 3). Default: 'UA-MIS'.
       * @visibility backend
       */
      oidcGroupPrefix?: string;
    };
    secrets?: {
      /**
       * Branch-name prefix for each set/delete PR (branch = <prefix><key>-<env>-<ts>).
       * Default: 'secrets/'.
       * @visibility backend
       */
      defaultBranchPrefix?: string;
      /**
       * Parent dir holding the per-env overlay dirs (dev/staging/prod).
       * Default: '.devops/chart/overlays'.
       * @visibility backend
       */
      overlaysDir?: string;
      /**
       * The ExternalSecret file the M4 scaffolder ships inside each overlay dir — the Secrets tab
       * upserts data[] entries into it (already a kustomization resource, so no overlay edit + no
       * kustomize load-restrictor escape). Default: 'app-secret.externalsecret.yaml'.
       * @visibility backend
       */
      overlayEsFile?: string;
      /**
       * Vault connection — where the secret VALUE is written (KV-v2 over k8s-auth).
       * @visibility backend
       */
      vault?: {
        /**
         * Vault base address. Default: https://vault.vault.svc.cluster.local:8200 .
         * @visibility backend
         */
        addr?: string;
        /**
         * KV-v2 mount. Default: 'secret'.
         * @visibility backend
         */
        mount?: string;
        /**
         * Kubernetes-auth mount path. Default: 'kubernetes'.
         * @visibility backend
         */
        authMount?: string;
        /**
         * Vault k8s-auth role bound to the dedicated Backstage SA. Default: 'backstage-writer'.
         * @visibility backend
         */
        role?: string;
        /**
         * Path to a projected SA token whose audience matches the Vault role's bound audience
         * ("vault") — NOT the default API-server token. The deploy mounts a serviceAccountToken
         * projected volume (audience: vault). Default: /var/run/secrets/vault/vault-token.
         * @visibility backend
         */
        saTokenPath?: string;
        /**
         * Path to the PEM CA bundle that signed the Vault server cert (TLS verify).
         * Default: /etc/backstage/vault-ca/ca.crt.
         * @visibility backend
         */
        caPath?: string;
      };
    };
  };
}
