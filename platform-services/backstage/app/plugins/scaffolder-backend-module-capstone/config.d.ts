/*
 * Config schema for the capstone secrets capability (M3). Declaring it here makes
 * `capstone.secrets.*` a known, validated config section (no "unknown key" warnings) and
 * documents each value. All optional — the action falls back to sensible defaults (see
 * readSecretsConfig in src/actions/sealSecret.ts).
 */
export interface Config {
  capstone?: {
    secrets?: {
      /**
       * Path to the mounted PUBLIC sealing cert the action seals OFFLINE against
       * (`kubeseal --cert <path>`). Default: /etc/backstage/sealing-cert/sealing-cert.pem.
       * @visibility backend
       */
      sealingCertPath?: string;
      /**
       * The kubeseal binary to invoke. Default: 'kubeseal' (PATH); the image bakes
       * /usr/local/bin/kubeseal.
       * @visibility backend
       */
      kubesealBin?: string;
      /**
       * Branch-name prefix for each seal PR (branch = <prefix><key>-<env>-<ts>).
       * Default: 'secrets/'.
       * @visibility backend
       */
      defaultBranchPrefix?: string;
      /**
       * Where the SealedSecret lands in the team app repo (per-key file).
       * Default: '.devops/secrets'.
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
    };
  };
}
