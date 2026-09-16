/*
 * Standalone "Secrets" page (secrets-UX v1). Flow:
 *   1. List the projects/apps the signed-in user can manage (access-scoped server-side via
 *      sealCore — owned Components; labmx admin = ALL). Pick one.
 *   2. For the picked project: list its secret key NAMES (never values), seal/edit, delete.
 *
 * Write-only throughout: values are never shown. "Edit" is a transparent re-set (set a new
 * value → overwrites it in Vault). "Delete" removes the Vault value + opens a PR dropping the
 * key from the ExternalSecret declaration.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Grid, Link, Typography } from '@material-ui/core';
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
import {
  capstoneSecretsApiRef,
  EnvironmentSummary,
  ProjectSummary,
  SecretSummary,
} from '../api';
import { SecretsForm } from './SecretsForm';
import { SecretsList } from './SecretsList';

/** Step 1: the access-scoped project picker. */
function ProjectPicker(props: { onPick: (p: ProjectSummary) => void }) {
  const api = useApi(capstoneSecretsApiRef);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>();

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const list = await api.listMyProjects();
        if (active) setProjects(list);
      } catch (e) {
        if (active) setError(e as Error);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [api]);

  if (loading) return <Progress />;
  if (error) {
    return (
      <WarningPanel title="Could not list your projects" message={error.message} />
    );
  }
  if (projects.length === 0) {
    return (
      <InfoCard title="No projects">
        <Typography variant="body1">
          You don't have access to manage secrets for any projects yet. Secrets
          are scoped to apps your team owns.
        </Typography>
      </InfoCard>
    );
  }

  const columns: TableColumn<ProjectSummary>[] = [
    { title: 'Project', field: 'title' },
    { title: 'Owner', field: 'owner' },
    {
      title: '',
      sorting: false,
      render: row => (
        <Button
          size="small"
          color="primary"
          variant="outlined"
          onClick={() => props.onPick(row)}
          aria-label={`manage secrets for ${row.title}`}
        >
          Manage secrets
        </Button>
      ),
    },
  ];

  return (
    <Table<ProjectSummary>
      title="Your projects"
      options={{ search: true, paging: projects.length > 10 }}
      columns={columns}
      data={projects}
    />
  );
}

/** Step 2: manage secrets for the picked project (list + seal + edit + delete). */
function ProjectSecrets(props: {
  project: ProjectSummary;
  onBack: () => void;
}) {
  const { project } = props;
  const api = useApi(capstoneSecretsApiRef);

  const [secrets, setSecrets] = useState<SecretSummary[]>([]);
  const [environments, setEnvironments] = useState<EnvironmentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>();
  const [editing, setEditing] = useState<SecretSummary | undefined>();
  const [deleteMsg, setDeleteMsg] = useState<string | undefined>();
  const [deleteErr, setDeleteErr] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const res = await api.listSecrets(project.entityRef);
      setSecrets(res.secrets);
      setEnvironments(res.environments);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }, [api, project.entityRef]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleDelete = async (secret: SecretSummary) => {
    setDeleteMsg(undefined);
    setDeleteErr(undefined);
    // Honest: deletion opens a PR; confirm before opening it.
    // eslint-disable-next-line no-alert
    // The previous wording was "This opens a PR removing it; it's gone once merged" — which
    // is false in the direction that loses data. The Vault value is destroyed IMMEDIATELY,
    // before the PR exists; the PR only removes the declaration from git. On 2026-09-16 a
    // user closed that PR believing it would undo the delete. It did not: the value had been
    // gone for three seconds by the time the PR was created. Say what actually happens.
    const confirmed = window.confirm(
      `Delete "${secret.key}" from ${secret.env}?\n\n` +
        `The value is removed from Vault IMMEDIATELY and cannot be recovered by closing ` +
        `the pull request — the PR only removes the declaration from git.\n\n` +
        `Only the ${secret.env} environment is affected. If this key is also set in other ` +
        `environments, delete it there separately.`,
    );
    if (!confirmed) {
      return;
    }
    try {
      const res = await api.deleteSecret({
        entityRef: project.entityRef,
        key: secret.key,
        // The row the user clicked — NOT every environment that declares this key.
        env: secret.env,
      });
      setDeleteMsg(res.pullRequestUrl);
      await refresh();
    } catch (e) {
      setDeleteErr((e as Error).message);
    }
  };

  return (
    <>
      <Button onClick={props.onBack} aria-label="back to projects">
        ← Projects
      </Button>
      <Typography variant="h6" gutterBottom>
        {project.title} <Typography variant="caption">({project.owner})</Typography>
      </Typography>
      <Grid container spacing={3}>
        <Grid item xs={12} md={6}>
          <SecretsForm
            key={editing?.key ?? 'new'}
            initialKey={editing?.key}
            initialEnvs={editing ? [editing.env] : undefined}
            onSeal={async input => {
              const res = await api.sealSecret({
                entityRef: project.entityRef,
                ...input,
              });
              setEditing(undefined);
              await refresh();
              return res;
            }}
          />
        </Grid>
        <Grid item xs={12} md={6}>
          {deleteErr && (
            <Typography variant="body2" color="error" role="alert">
              {deleteErr}
            </Typography>
          )}
          {deleteMsg && (
            <Typography variant="body2" gutterBottom>
              Delete PR opened:{' '}
              <Link href={deleteMsg} target="_blank" rel="noopener noreferrer">
                {deleteMsg}
              </Link>
            </Typography>
          )}
          <SecretsList
            secrets={secrets}
            environments={environments}
            loading={loading}
            error={error}
            onEdit={s => setEditing(s)}
            onDelete={handleDelete}
          />
        </Grid>
      </Grid>
    </>
  );
}

export function SecretsPage() {
  const [picked, setPicked] = useState<ProjectSummary | undefined>();

  return (
    <Page themeId="tool">
      <Header
        title="Secrets"
        subtitle="Seal team secrets (write-only) and open a PR to your app repo"
      />
      <Content>
        <ContentHeader title="Team secrets">
          <SupportButton>
            Secret values are written to Vault; an ExternalSecret declaration
            (key names only, no values) is committed to your app repo via a pull
            request. Values are write-only — they are never shown.
          </SupportButton>
        </ContentHeader>
        {picked ? (
          <ProjectSecrets project={picked} onBack={() => setPicked(undefined)} />
        ) : (
          <ProjectPicker onPick={setPicked} />
        )}
      </Content>
    </Page>
  );
}
