/*
 * Component tests for SecretsForm — the WRITE-ONLY contract (plan §7 frontend):
 *  - the value input is type=password (never visually echoed),
 *  - write-only copy is present, no "reveal" affordance,
 *  - on success the PR URL(s) are surfaced and the value field is CLEARED,
 *  - an error (e.g. forbidden) is surfaced without echoing the value,
 *  - a disabled (no-permission) state renders.
 * Uses renderInTestApp so core-components (InfoCard) get the core APIs they require.
 */
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderInTestApp } from '@backstage/frontend-test-utils';
import { SecretsForm } from './SecretsForm';

const VALUE = 'my-PLAINTEXT-secret';

describe('SecretsForm', () => {
  it('renders write-only copy and a password value input', async () => {
    await renderInTestApp(<SecretsForm onSeal={jest.fn()} />);
    expect(screen.getByText(/write-only/i)).toBeInTheDocument();
    const valueInput = screen.getByLabelText('secret value') as HTMLInputElement;
    expect(valueInput.type).toBe('password');
    // No reveal/show affordance.
    expect(screen.queryByText(/reveal|show value/i)).not.toBeInTheDocument();
  });

  it('seals and surfaces the PR URL(s), then clears the value', async () => {
    const onSeal = jest
      .fn()
      .mockResolvedValue({ pullRequestUrls: ['https://github.com/x/y/pull/1'] });
    await renderInTestApp(<SecretsForm onSeal={onSeal} />);

    fireEvent.change(screen.getByLabelText('secret key'), {
      target: { value: 'DATABASE_URL' },
    });
    const valueInput = screen.getByLabelText('secret value') as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: VALUE } });

    fireEvent.click(screen.getByRole('button', { name: /seal/i }));

    await waitFor(() =>
      expect(onSeal).toHaveBeenCalledWith({
        key: 'DATABASE_URL',
        value: VALUE,
        envs: ['dev'],
      }),
    );
    // PR URL surfaced.
    expect(
      await screen.findByText('https://github.com/x/y/pull/1'),
    ).toBeInTheDocument();
    // Value cleared after submit (not retained in the DOM).
    expect(valueInput.value).toBe('');
  });

  it('surfaces an error without echoing the value', async () => {
    const onSeal = jest
      .fn()
      .mockRejectedValue(
        new Error('Failed to seal secret (403): not the owner'),
      );
    await renderInTestApp(<SecretsForm onSeal={onSeal} />);
    fireEvent.change(screen.getByLabelText('secret key'), {
      target: { value: 'K' },
    });
    fireEvent.change(screen.getByLabelText('secret value'), {
      target: { value: VALUE },
    });
    fireEvent.click(screen.getByRole('button', { name: /seal/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/403/);
    expect(alert).not.toHaveTextContent(VALUE);
  });

  it('renders a disabled state with reason when not permitted', async () => {
    await renderInTestApp(
      <SecretsForm
        onSeal={jest.fn()}
        disabled
        disabledReason="You do not own this component."
      />,
    );
    expect(
      screen.getByText('You do not own this component.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /seal/i })).toBeDisabled();
  });
});
