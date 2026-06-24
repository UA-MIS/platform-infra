/*
 * Config schema for the capstone secrets capability (M3, ESO+Vault model — ADR-030 B1).
 * Declaring it here makes `capstone.secrets.*` a known, validated config section (no "unknown
 * key" warnings) and documents each value. All optional — sealCore falls back to sensible
 * defaults (see readSecretsConfig in src/sealCore.ts).
 */
export interface Config {
  capstone?: {
    secrets?: {
      /**
       * Branch-name prefix for each set/delete PR (branch = <prefix><key>-<env>-<ts>).
       * Default: 'secrets/'.
       * @visibility backend
       */
      defaultBranchPrefix?: string;
      /**
       * Where the ExternalSecret declaration lands in the team app repo
       * (externalsecret-<env>.yaml). Default: '.devops/secrets'.
       * @visibility backend
       */
      secretsDir?: string;
      /**
       * Relative path from an env overlay's kustomization.yaml to the secrets dir.
       * Default: '../../secrets'.
       * @visibility backend
       */
      overlayRelPath?: string;
      /**
       * Parent dir holding the per-env overlay kustomizations.
       * Default: '.devops/chart/overlays'.
       * @visibility backend
       */
      overlaysDir?: string;
      /**
       * The k8s Secret the ExternalSecret materializes (target.name + the ExternalSecret name).
       * Must match the per-tenant SecretStore contract. Default: 'app-secrets'.
       * @visibility backend
       */
      targetSecretName?: string;
      /**
       * The per-tenant SecretStore the ExternalSecret references. Default: 'vault-tenant'.
       * @visibility backend
       */
      secretStoreName?: string;
      /**
       * The SecretStore kind referenced (SecretStore | ClusterSecretStore).
       * Default: 'SecretStore'.
       * @visibility backend
       */
      secretStoreKind?: string;
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
         * Vault k8s-auth role bound to the Backstage SA. Default: 'backstage-secrets'.
         * @visibility backend
         */
        role?: string;
        /**
         * Path to the projected SA JWT.
         * Default: /var/run/secrets/kubernetes.io/serviceaccount/token.
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
