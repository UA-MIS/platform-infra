/*
 * Component tests for SecretsList — write-only listing: shows key NAMES + env + last-updated,
 * never a value (plan §2.4 / §7). Uses renderInTestApp so core-components (Table, EmptyState,
 * WarningPanel) get the core APIs (errorApi etc.) they require.
 */
import { screen, fireEvent } from '@testing-library/react';
import { renderInTestApp } from '@backstage/frontend-test-utils';
import { SecretsList } from './SecretsList';

describe('SecretsList', () => {
  it('lists key names + env + last-updated, never a value column', async () => {
    await renderInTestApp(
      <SecretsList
        loading={false}
        secrets={[
          {
            key: 'DATABASE_URL',
            env: 'dev',
            lastUpdated: '2026-06-19T00:00:00Z',
          },
          { key: 'API_KEY', env: 'prod' },
        ]}
      />,
    );
    expect(screen.getByText('DATABASE_URL')).toBeInTheDocument();
    expect(screen.getByText('API_KEY')).toBeInTheDocument();
    // The write-only contract is in the table title; there is no "Value" column.
    expect(screen.getByText(/values are never shown/i)).toBeInTheDocument();
    expect(screen.queryByText(/^value$/i)).not.toBeInTheDocument();
  });

  it('shows an empty state (still no values) when there are none', async () => {
    await renderInTestApp(<SecretsList loading={false} secrets={[]} />);
    expect(screen.getByText(/no secrets sealed yet/i)).toBeInTheDocument();
  });

  it('surfaces a load error', async () => {
    await renderInTestApp(
      <SecretsList loading={false} secrets={[]} error={new Error('boom')} />,
    );
    expect(screen.getByText(/could not list secrets/i)).toBeInTheDocument();
  });

  it('renders Edit/Delete actions and fires the callbacks (still no values)', async () => {
    const onEdit = jest.fn();
    const onDelete = jest.fn();
    await renderInTestApp(
      <SecretsList
        loading={false}
        secrets={[{ key: 'DATABASE_URL', env: 'dev' }]}
        onEdit={onEdit}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByLabelText('edit DATABASE_URL'));
    expect(onEdit).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'DATABASE_URL', env: 'dev' }),
    );
    fireEvent.click(screen.getByLabelText('delete DATABASE_URL'));
    expect(onDelete).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'DATABASE_URL' }),
    );
  });

  it('omits the Actions column when no callbacks are given', async () => {
    await renderInTestApp(
      <SecretsList loading={false} secrets={[{ key: 'K', env: 'dev' }]} />,
    );
    expect(screen.queryByText(/^actions$/i)).not.toBeInTheDocument();
  });
});
