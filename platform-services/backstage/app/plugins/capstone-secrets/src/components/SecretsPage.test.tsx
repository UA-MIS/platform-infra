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
    listSecrets: jest
      .fn()
      .mockResolvedValue([{ key: 'DATABASE_URL', env: 'dev' }]),
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
      }),
    );
    expect(
      await screen.findByText('https://github.com/x/y/pull/2'),
    ).toBeInTheDocument();
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
