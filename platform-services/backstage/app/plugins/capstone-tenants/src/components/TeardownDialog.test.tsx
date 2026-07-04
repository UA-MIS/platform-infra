/*
 * Component tests for TeardownDialog — the REQUIRED type-the-name-to-confirm safety guard:
 *  - the "Delete tenant" button is DISABLED until the exact tenant name is typed,
 *  - typing the wrong name keeps it disabled; the right name enables it,
 *  - confirming calls onConfirm with {confirmName, archiveRepo} and surfaces the PR URL,
 *  - the archive checkbox is forwarded,
 *  - an error from onConfirm is surfaced and the dialog stays open.
 */
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderInTestApp } from '@backstage/frontend-test-utils';
import { TeardownDialog } from './TeardownDialog';
import { TenantSummary } from '../api';

const TENANT: TenantSummary = {
  name: 'swami-swamiapp',
  team: 'swami',
  appName: 'swamiapp',
  semester: '2026-summer',
  database: 'mysql',
  claimPath: 'tenants/_claims/swami-swamiapp.yaml',
};

function renderDialog(onConfirm = jest.fn()) {
  return renderInTestApp(
    <TeardownDialog
      tenant={TENANT}
      open
      onClose={jest.fn()}
      onConfirm={onConfirm}
    />,
  );
}

describe('TeardownDialog', () => {
  it('disables Delete until the exact tenant name is typed', async () => {
    await renderDialog();
    const del = screen.getByRole('button', { name: /delete tenant/i });
    expect(del).toBeDisabled();

    // Wrong name -> still disabled.
    fireEvent.change(screen.getByLabelText('confirm tenant name'), {
      target: { value: 'swami' },
    });
    expect(del).toBeDisabled();

    // Exact name -> enabled.
    fireEvent.change(screen.getByLabelText('confirm tenant name'), {
      target: { value: 'swami-swamiapp' },
    });
    expect(del).toBeEnabled();
  });

  it('confirms with the typed name + archive flag and surfaces the PR URL', async () => {
    const onConfirm = jest.fn().mockResolvedValue({
      pullRequestUrl: 'https://github.com/UA-MIS/platform-infra/pull/42',
      claimPath: TENANT.claimPath,
      repoArchived: true,
    });
    await renderDialog(onConfirm);

    fireEvent.change(screen.getByLabelText('confirm tenant name'), {
      target: { value: 'swami-swamiapp' },
    });
    fireEvent.click(screen.getByLabelText('also archive github repo'));
    fireEvent.click(screen.getByRole('button', { name: /delete tenant/i }));

    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith({
        confirmName: 'swami-swamiapp',
        archiveRepo: true,
      }),
    );
    expect(
      await screen.findByText('https://github.com/UA-MIS/platform-infra/pull/42'),
    ).toBeInTheDocument();
    // Honest async messaging: nothing is deleted until the PR merges.
    expect(screen.getByText(/nothing is deleted yet/i)).toBeInTheDocument();
  });

  it('surfaces an error and keeps the dialog open', async () => {
    const onConfirm = jest
      .fn()
      .mockRejectedValue(new Error('Failed to tear down tenant (403): not an admin'));
    await renderDialog(onConfirm);

    fireEvent.change(screen.getByLabelText('confirm tenant name'), {
      target: { value: 'swami-swamiapp' },
    });
    fireEvent.click(screen.getByRole('button', { name: /delete tenant/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/not an admin/i);
    // Still on the confirm step (Delete button present, not the success Close-only state).
    expect(
      screen.getByRole('button', { name: /delete tenant/i }),
    ).toBeInTheDocument();
  });
});
