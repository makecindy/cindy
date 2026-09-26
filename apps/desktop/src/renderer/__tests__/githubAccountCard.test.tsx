// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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
