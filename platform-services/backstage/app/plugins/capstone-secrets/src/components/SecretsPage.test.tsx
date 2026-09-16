/*
 * Component tests for the standalone SecretsPage (secrets-UX v1): the access-scoped project
 * picker → manage flow. The api is mocked via TestApiProvider; values are NEVER shown.
 */
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderInTestApp, TestApiProvider } from '@backstage/frontend-test-utils';
import { capstoneSecretsApiRef, CapstoneSecretsApi } from '../api';
import { SecretsPage } from './SecretsPage';

function mockApi(overrides: Partial<CapstoneSecretsApi> = {}): CapstoneSecretsApi {
  return {
    listMyProjects: jest
      .fn()
      .mockResolvedValue([
        { entityRef: 'component:default/my-app', title: 'My App', owner: 'team-a' },
      ]),
    listSecrets: jest.fn().mockResolvedValue({
      secrets: [{ key: 'DATABASE_URL', env: 'dev' }],
      environments: [{ env: 'dev', declaredKeyCount: 1 }],
    }),
    sealSecret: jest
      .fn()
      .mockResolvedValue({ pullRequestUrls: ['https://github.com/x/y/pull/1'] }),
    deleteSecret: jest
      .fn()
      .mockResolvedValue({ pullRequestUrl: 'https://github.com/x/y/pull/2' }),
    ...overrides,
  };
}

async function renderPage(api: CapstoneSecretsApi) {
  await renderInTestApp(
    <TestApiProvider apis={[[capstoneSecretsApiRef, api]]}>
      <SecretsPage />
    </TestApiProvider>,
  );
}

describe('SecretsPage', () => {
  it('lists the access-scoped projects, then manages the picked one (no values)', async () => {
    const api = mockApi();
    await renderPage(api);

    // Step 1: project picker.
    expect(await screen.findByText('My App')).toBeInTheDocument();
    expect(api.listMyProjects).toHaveBeenCalled();

    // Pick the project.
    fireEvent.click(screen.getByLabelText('manage secrets for My App'));

    // Step 2: its secrets list (key name, never a value).
    expect(await screen.findByText('DATABASE_URL')).toBeInTheDocument();
    expect(api.listSecrets).toHaveBeenCalledWith('component:default/my-app');
    expect(screen.getByText(/values are never shown/i)).toBeInTheDocument();
  });

  it('shows an empty state when the user has no accessible projects', async () => {
    const api = mockApi({ listMyProjects: jest.fn().mockResolvedValue([]) });
    await renderPage(api);
    expect(await screen.findByText(/no projects/i)).toBeInTheDocument();
  });

  it('Edit puts the form in re-seal mode for the chosen key', async () => {
    const api = mockApi();
    await renderPage(api);
    fireEvent.click(await screen.findByLabelText('manage secrets for My App'));
    fireEvent.click(await screen.findByLabelText('edit DATABASE_URL'));
    // Edit mode prefills + locks the key (title reflects the edited key).
    expect(
      await screen.findByText(/edit secret: DATABASE_URL/i),
    ).toBeInTheDocument();
  });

  it('Delete (confirmed) calls deleteSecret and surfaces the PR url', async () => {
    const api = mockApi();
    const confirmSpy = jest
      .spyOn(window, 'confirm')
      .mockReturnValue(true);
    await renderPage(api);
    fireEvent.click(await screen.findByLabelText('manage secrets for My App'));
    fireEvent.click(await screen.findByLabelText('delete DATABASE_URL'));

    await waitFor(() =>
      expect(api.deleteSecret).toHaveBeenCalledWith({
        entityRef: 'component:default/my-app',
        key: 'DATABASE_URL',
        // The row the user clicked — not every env declaring the key (mychef, 2026-09-16).
        env: 'dev',
      }),
    );
    expect(
      await screen.findByText('https://github.com/x/y/pull/2'),
    ).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  // The old dialog said "This opens a PR removing it; it's gone once merged" — false, and
  // false in the direction that loses data: the Vault value is destroyed before the PR
  // exists. A user closed that PR believing it would undo the delete. It did not.
  it('the confirmation says the value is destroyed immediately, and names the environment', async () => {
    const api = mockApi();
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false);
    await renderPage(api);
    fireEvent.click(await screen.findByLabelText('manage secrets for My App'));
    fireEvent.click(await screen.findByLabelText('delete DATABASE_URL'));

    const msg = confirmSpy.mock.calls[0][0] as string;
    expect(msg).toMatch(/IMMEDIATELY/);
    expect(msg).toMatch(/cannot be recovered by closing/i);
    expect(msg).toMatch(/dev/);
    // and it must NOT repeat the old, false promise
    expect(msg).not.toMatch(/gone once merged/i);
    confirmSpy.mockRestore();
  });

  it('Delete (cancelled) does NOT call deleteSecret', async () => {
    const api = mockApi();
    const confirmSpy = jest
      .spyOn(window, 'confirm')
      .mockReturnValue(false);
    await renderPage(api);
    fireEvent.click(await screen.findByLabelText('manage secrets for My App'));
    fireEvent.click(await screen.findByLabelText('delete DATABASE_URL'));
    expect(api.deleteSecret).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
