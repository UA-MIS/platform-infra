/*
 * The write-only listing: existing secret key NAMES + last-updated, per env. NEVER values
 * (plan §2.4). There is no reveal affordance by design — the values live in Vault and cannot
 * be read back here.
 */
import { Button } from '@material-ui/core';
import {
  Table,
  TableColumn,
  Progress,
  EmptyState,
  WarningPanel,
} from '@backstage/core-components';
import { EnvironmentSummary, SecretSummary } from '../api';

export function SecretsList(props: {
  secrets: SecretSummary[];
  /**
   * Environments that HAVE an overlay ExternalSecret, whether or not they declare keys. Used
   * to tell "configured, no secrets yet" apart from "this app has no such environment" — the
   * old listing collapsed both into an identical blank panel.
   */
  environments?: EnvironmentSummary[];
  loading: boolean;
  error?: Error;
  /** When provided, each row gets an "Edit" (re-seal) action. */
  onEdit?: (secret: SecretSummary) => void;
  /** When provided, each row gets a "Delete" (opens a PR) action. */
  onDelete?: (secret: SecretSummary) => void;
}) {
  const { secrets, environments, loading, error, onEdit, onDelete } = props;

  if (loading) {
    return <Progress />;
  }
  if (error) {
    return (
      <WarningPanel title="Could not list secrets" message={error.message} />
    );
  }
  if (secrets.length === 0) {
    const envs = (environments ?? []).map(e => e.env);
    const description: string =
      envs.length > 0
        ? `No secrets are declared yet for ${envs.join(', ')}. Sealed secrets you create appear here by key name. Values are write-only — they are never shown.`
        : 'Sealed secrets you create appear here by key name. Values are write-only — they are never shown.';
    return (
      <EmptyState
        missing="content"
        title="No secrets sealed yet"
        description={description}
      />
    );
  }

  const columns: TableColumn<SecretSummary>[] = [
    { title: 'Key', field: 'key' },
    { title: 'Environment', field: 'env' },
    {
      title: 'Last updated',
      field: 'lastUpdated',
      render: row =>
        row.lastUpdated ? new Date(row.lastUpdated).toLocaleString() : '—',
    },
  ];

  if (onEdit || onDelete) {
    columns.push({
      title: 'Actions',
      sorting: false,
      render: row => (
        <>
          {onEdit && (
            <Button
              size="small"
              color="primary"
              onClick={() => onEdit(row)}
              aria-label={`edit ${row.key}`}
            >
              Edit
            </Button>
          )}
          {onDelete && (
            <Button
              size="small"
              color="secondary"
              onClick={() => onDelete(row)}
              aria-label={`delete ${row.key}`}
            >
              Delete
            </Button>
          )}
        </>
      ),
    });
  }

  return (
    <Table<SecretSummary>
      title="Sealed secrets (write-only — values are never shown)"
      options={{ search: true, paging: secrets.length > 10 }}
      columns={columns}
      data={secrets}
    />
  );
}
