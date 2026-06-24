/*
 * Standalone "Secrets" page (secrets-UX v1). Flow:
 *   1. List the projects/apps the signed-in user can manage (access-scoped server-side via
 *      sealCore — owned Components; labmx admin = ALL). Pick one.
 *   2. For the picked project: list its secret key NAMES (never values), seal/edit, delete.
 *
 * Write-only throughout: values are never shown. "Edit" is a transparent re-seal (set a new
 * value → overwrites). "Delete" opens a PR removing the SealedSecret (not instant).
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>();
  const [editing, setEditing] = useState<SecretSummary | undefined>();
  const [deleteMsg, setDeleteMsg] = useState<string | undefined>();
  const [deleteErr, setDeleteErr] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setSecrets(await api.listSecrets(project.entityRef));
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
    const confirmed = window.confirm(
      `Delete secret "${secret.key}"? This opens a PR removing it; it's gone once merged.`,
    );
    if (!confirmed) {
      return;
    }
    try {
      const res = await api.deleteSecret({
        entityRef: project.entityRef,
        key: secret.key,
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
            Secrets are sealed with kubeseal and committed to your app repo as a
            SealedSecret via a pull request. Values are write-only — they are
            never shown.
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
