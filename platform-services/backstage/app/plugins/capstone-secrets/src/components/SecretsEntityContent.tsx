/*
 * The "Secrets" entity tab content (rendered on a Component the user owns) — wires the form +
 * the write-only listing for the CURRENT entity (plan §2.4). The owner gate is enforced
 * server-side (the backend re-authorizes capstone.secret.seal + re-checks ownership); this UI
 * surfaces a forbidden state from a failed list/seal but never makes the client the security
 * boundary.
 */
import { useCallback, useEffect, useState } from 'react';
import { Grid } from '@material-ui/core';
import { Content } from '@backstage/core-components';
import { useEntity } from '@backstage/plugin-catalog-react';
import { useApi } from '@backstage/core-plugin-api';
import { stringifyEntityRef } from '@backstage/catalog-model';
import { capstoneSecretsApiRef, SecretSummary } from '../api';
import { SecretsForm } from './SecretsForm';
import { SecretsList } from './SecretsList';

export function SecretsEntityContent() {
  const { entity } = useEntity();
  const api = useApi(capstoneSecretsApiRef);
  const entityRef = stringifyEntityRef(entity);

  const [secrets, setSecrets] = useState<SecretSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setSecrets(await api.listSecrets(entityRef));
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }, [api, entityRef]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <Content>
      <Grid container spacing={3}>
        <Grid item xs={12} md={6}>
          <SecretsForm
            onSeal={async input => {
              const res = await api.sealSecret({ entityRef, ...input });
              // After a successful seal the listing may change once the PR merges; refresh to
              // reflect any same-branch updates. (Values are never shown either way.)
              await refresh();
              return res;
            }}
          />
        </Grid>
        <Grid item xs={12} md={6}>
          <SecretsList secrets={secrets} loading={loading} error={error} />
        </Grid>
      </Grid>
    </Content>
  );
}
