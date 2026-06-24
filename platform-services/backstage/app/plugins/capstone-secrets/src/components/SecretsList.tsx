/*
 * The write-only listing: existing secret key NAMES + last-updated, per env. NEVER values
 * (plan §2.4). There is no reveal affordance by design — the values are sealed and cannot be
 * read back.
 */
import {
  Table,
  TableColumn,
  Progress,
  EmptyState,
  WarningPanel,
} from '@backstage/core-components';
import { SecretSummary } from '../api';

export function SecretsList(props: {
  secrets: SecretSummary[];
  loading: boolean;
  error?: Error;
}) {
  const { secrets, loading, error } = props;

  if (loading) {
    return <Progress />;
  }
  if (error) {
    return (
      <WarningPanel title="Could not list secrets" message={error.message} />
    );
  }
  if (secrets.length === 0) {
    return (
      <EmptyState
        missing="content"
        title="No secrets sealed yet"
        description="Sealed secrets you create appear here by key name. Values are write-only — they are never shown."
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

  return (
    <Table<SecretSummary>
      title="Sealed secrets (write-only — values are never shown)"
      options={{ search: true, paging: secrets.length > 10 }}
      columns={columns}
      data={secrets}
    />
  );
}
