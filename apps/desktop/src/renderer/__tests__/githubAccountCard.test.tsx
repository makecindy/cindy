// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { GithubAccountCard } from '../features/cc-agent/GithubAccountCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: { login?: string }) => key + (args?.login ? ':' + args.login : ''),
  }),
}));
vi.mock('../features/cc-agent/GithubConnectButton', () => ({
  GithubConnectButton: ({ visible }: { visible: boolean }) =>
    visible ? <button>connect</button> : null,
}));
afterEach(cleanup);
const prefix = 'ccAgent.gitContext.pr.setup.account.';

it('shows verified identity without asking an already connected user to connect', async () => {
  window.electronAPI = {
    gitContext: {
      githubConnection: async () => ({ status: 'connected', login: 'dashhuang', source: 'gh-cli' }),
      onGithubConnected: () => () => {},
    },
  } as any;
  render(<GithubAccountCard onConnected={() => {}} />);
  expect(await screen.findByText(prefix + 'connected:dashhuang')).toBeTruthy();
  expect(screen.queryByText('connect')).toBeNull();
  expect(screen.queryByText(prefix + 'recheck')).toBeNull();
  expect(screen.getByText(prefix + 'gh-cli')).toBeTruthy();
});

it('refreshes credential changes and ignores an older in-flight response', async () => {
  let changed = () => {};
  let finishOld!: (value: any) => void;
  const request = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockResolvedValue({ status: 'connected', login: 'new-account', source: 'token' });
  window.electronAPI = {
    gitContext: {
      githubConnection: request,
      onGithubConnected: (callback: () => void) => {
        changed = callback;
        return () => {};
      },
    },
  } as any;
  render(<GithubAccountCard onConnected={() => {}} />);
  await act(async () => changed());
  expect(await screen.findByText(prefix + 'connected:new-account')).toBeTruthy();
  await act(async () => finishOld({ status: 'missing' }));
  expect(screen.queryByText('connect')).toBeNull();
  expect(screen.getByText(prefix + 'token')).toBeTruthy();
});

it.each(['gh-cli', 'token'])(
  'keeps login available after %s authentication fails',
  async (source) => {
    window.electronAPI = {
      gitContext: {
        githubConnection: async () => ({ status: 'auth', source }),
        onGithubConnected: () => () => {},
      },
    } as any;
    render(<GithubAccountCard onConnected={() => {}} />);
    expect(await screen.findByText('connect')).toBeTruthy();
    expect(screen.getByText(prefix + 'auth')).toBeTruthy();
  },
);

it('does not misrepresent a network failure as a request to log in', async () => {
  window.electronAPI = {
    gitContext: {
      githubConnection: async () => ({ status: 'network', source: 'gh-cli' }),
      onGithubConnected: () => () => {},
    },
  } as any;
  render(<GithubAccountCard onConnected={() => {}} />);
  await waitFor(() => expect(screen.getByText(prefix + 'network')).toBeTruthy());
  expect(screen.queryByText('connect')).toBeNull();
  expect(screen.getByText(prefix + 'recheck')).toBeTruthy();
});

// Regression: the plugin showed “connect GitHub” beside “connected” for an
// event-only account. Render the production combined entry (unit/jsdom); the
// standalone account tests cannot observe this contradictory two-source state.
it.each([
  [{ status: 'missing' }, 'event-account', 'incomplete'],
  [{ status: 'connected', login: 'actor', source: 'gh-cli' }, 'other', 'mismatch'],
  [{ status: 'connected', login: 'actor', source: 'token' }, 'actor', 'ready'],
])('explains the effective capabilities of both connections', async (account, login, summary) => {
  window.electronAPI = { gitContext: {
    githubConnection: async () => account,
    githubAppStatus: async () => ({ available: true, login, repositories: [] }),
    onGithubConnected: () => () => {},
  } } as any;
  render(<GithubAccountCard includeEvents onConnected={() => {}} />);
  expect(await screen.findByText('ccAgent.gitContext.pr.setup.connection.' + summary)).toBeTruthy();
  expect(screen.getByText('ccAgent.gitContext.pr.setup.connection.operations')).toBeTruthy();
});

// New-capability server: one App action completes the existing event-only connection.
it('uses the unified App action to finish an event-only account', async () => {
  const connectGithubApp = vi.fn(async () => {});
  window.electronAPI = { gitContext: {
    githubConnection: async () => ({ status: 'missing' }),
    githubAppStatus: async () => ({ available: true, login: 'example', repositories: [], userAuthorization: true }),
    onGithubConnected: () => () => {}, connectGithubApp,
  } } as any;
  render(<GithubAccountCard includeEvents onConnected={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'ccAgent.gitContext.pr.setup.connection.connect' }));
  expect(connectGithubApp).toHaveBeenCalledOnce();
  await screen.findByText('ccAgent.gitContext.pr.setup.app.finishInBrowser');
  expect(screen.queryByText('ccAgent.gitContext.pr.setup.connection.ready')).toBeNull();
});
