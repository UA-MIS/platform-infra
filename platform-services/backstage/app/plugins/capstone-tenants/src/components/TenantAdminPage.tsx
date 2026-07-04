/*
 * The admin Tenant Teardown page. Flow:
 *   1. List every LIVE tenant (one CapstoneTenant claim in platform-infra:tenants/_claims).
 *      The list IS the delete surface — each row maps 1:1 to a claim file the teardown removes.
 *   2. Click "Tear down" → the type-the-name-to-confirm dialog → open a PR removing the claim.
 *
 * Async by design: teardown opens a PR; the Crossplane cascade (the actual resource reclaim)
 * runs when an admin merges it. After a successful teardown we refresh the list — the torn-down
 * tenant stays visible until the PR merges (its claim file still exists), which is the honest
 * status signal (still listed = still provisioned). ADMIN-ONLY server-side: a non-admin gets an
 * empty list + a 403 on any teardown attempt.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Chip, Typography } from '@material-ui/core';
import {
  Content,
  ContentHeader,
  Header,
  InfoCard,
  Page,
  Progress,
  SupportButton,
  Table,
  TableColumn,
  WarningPanel,
} from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import { capstoneTenantsApiRef, TenantSummary } from '../api';
import { TeardownDialog } from './TeardownDialog';

export function TenantAdminPage() {
  const api = useApi(capstoneTenantsApiRef);
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>();
  const [target, setTarget] = useState<TenantSummary | undefined>();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setTenants(await api.listTenants());
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const columns: TableColumn<TenantSummary>[] = [
    { title: 'Tenant', field: 'name', defaultSort: 'asc' },
    { title: 'Team', field: 'team' },
    { title: 'App', field: 'appName' },
    { title: 'Semester', field: 'semester' },
    {
      title: 'Database',
      field: 'database',
      render: row =>
        row.database && row.database !== 'none' ? (
          <Chip size="small" label={row.database} />
        ) : (
          <Typography variant="caption">—</Typography>
        ),
    },
    {
      title: '',
      sorting: false,
      render: row => (
        <Button
          size="small"
          color="secondary"
          variant="outlined"
          onClick={() => setTarget(row)}
          aria-label={`tear down ${row.name}`}
        >
          Tear down
        </Button>
      ),
    },
  ];

  const body = () => {
    if (loading) {
      return <Progress />;
    }
    if (error) {
      return (
        <WarningPanel title="Could not list tenants" message={error.message} />
      );
    }
    if (tenants.length === 0) {
      return (
        <InfoCard title="No tenants">
          <Typography variant="body1">
            No provisioned tenants were found — or you are not a platform
            administrator (tenant teardown is admin-only).
          </Typography>
        </InfoCard>
      );
    }
    return (
      <Table<TenantSummary>
        title={`Provisioned tenants (${tenants.length})`}
        options={{ search: true, paging: tenants.length > 10 }}
        columns={columns}
        data={tenants}
      />
    );
  };

  return (
    <Page themeId="tool">
      <Header
        title="Tenant Admin"
        subtitle="Reclaim cluster resources by tearing down finished tenant projects"
      />
      <Content>
        <ContentHeader title="Tenant teardown">
          <SupportButton>
            Each row is one CapstoneTenant. Tearing one down opens a pull request that
            removes its claim from platform-infra; on merge, Crossplane cascade-deletes the
            whole tenant (namespaces, pods, Harbor project, Vault paths, database, ArgoCD
            apps). Admin-only.
          </SupportButton>
        </ContentHeader>
        {body()}
        {target && (
          <TeardownDialog
            tenant={target}
            open={Boolean(target)}
            onClose={() => setTarget(undefined)}
            onConfirm={async input => {
              const res = await api.teardownTenant({
                name: target.name,
                confirmName: input.confirmName,
                archiveRepo: input.archiveRepo,
              });
              // Refresh in the background; the row stays until the PR merges (honest status).
              await refresh();
              return res;
            }}
          />
        )}
      </Content>
    </Page>
  );
}
