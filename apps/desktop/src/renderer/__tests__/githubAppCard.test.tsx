// @vitest-environment jsdom
// Production UI boundary: connection remains user initiated; unavailable deployments hide the entry.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { GithubAppCard } from '../features/cc-agent/GithubAppCard';
import type { GithubAppConnectionState } from '../../shared/githubSetup';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
const prefix = 'ccAgent.gitContext.pr.setup.app.';
const checking = 'ccAgent.gitContext.pr.setup.account.checking';
const recheck = 'ccAgent.gitContext.pr.setup.account.recheck';

it('shows checking until the first reply and shares an in-flight focus refresh', async () => {
  let complete!: (state: GithubAppConnectionState) => void;
  const githubAppStatus = vi.fn(() => new Promise<GithubAppConnectionState>(resolve => { complete = resolve; }));
  window.electronAPI = { gitContext: { githubAppStatus } } as unknown as typeof window.electronAPI;
  render(<GithubAppCard />);
  expect(screen.getByText(checking)).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
  fireEvent(window, new Event('focus'));
  fireEvent(window, new Event('focus'));
  expect(githubAppStatus).toHaveBeenCalledOnce();
  await act(async () => complete({ available: true, login: 'example-user' }));
  expect(screen.getByText(prefix + 'connected')).toBeTruthy();
  expect(screen.queryByText(prefix + 'connect')).toBeNull();
  expect(screen.queryByText(checking)).toBeNull();
});

it('never offers reconnect from an outdated disconnected snapshot after a failed refresh', async () => {
  const githubAppStatus = vi.fn<() => Promise<GithubAppConnectionState>>()
    .mockResolvedValueOnce({ available: true, login: null })
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValue({ available: true, login: 'example-user' });
  const connectGithubApp = vi.fn();
  window.electronAPI = { gitContext: { githubAppStatus, connectGithubApp } } as unknown as typeof window.electronAPI;
  render(<GithubAppCard />);
  await screen.findByText(prefix + 'connect');
  fireEvent(window, new Event('focus'));
  expect((screen.getByRole('button', { name: prefix + 'connect' }) as HTMLButtonElement).disabled).toBe(true);
  await screen.findByRole('alert');
  expect(screen.queryByText(prefix + 'connect')).toBeNull();
  fireEvent.click(screen.getByText(recheck));
  await screen.findByText(prefix + 'connected');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(connectGithubApp).not.toHaveBeenCalled();
});

it('keeps the last connected account during an outage and recovers on focus', async () => {
  const githubAppStatus = vi.fn<() => Promise<GithubAppConnectionState>>()
    .mockResolvedValueOnce({ available: true, login: 'example-user' })
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValue({ available: true, login: 'example-user' });
  window.electronAPI = { gitContext: { githubAppStatus } } as unknown as typeof window.electronAPI;
  render(<GithubAppCard />);
  await screen.findByText(prefix + 'connected');
  fireEvent(window, new Event('focus'));
  await screen.findByRole('alert');
  expect(screen.getByText(prefix + 'connected')).toBeTruthy();
  expect(screen.queryByText(prefix + 'connect')).toBeNull();
  expect((screen.getByText(prefix + 'repositories') as HTMLButtonElement).disabled).toBe(true);
  fireEvent(window, new Event('focus'));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  await waitFor(() => expect((screen.getByText(prefix + 'repositories') as HTMLButtonElement).disabled).toBe(false));
});

it.each(['connect', 'repositories'])('waits for the browser return after %s and hides the stale repository count', async (action) => {
  const openBrowser = vi.fn(async () => {});
  let complete!: (state: GithubAppConnectionState) => void;
  const githubAppStatus = vi.fn<() => Promise<GithubAppConnectionState>>()
    .mockResolvedValueOnce({ available: true, login: action === 'connect' ? null : 'example-user', repositories: [] })
    .mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  window.electronAPI = { gitContext: { githubAppStatus, connectGithubApp: openBrowser, installGithubApp: openBrowser } } as unknown as typeof window.electronAPI;
  render(<GithubAppCard />);
  fireEvent.click(await screen.findByText(prefix + action));
  await screen.findByText(prefix + 'finishInBrowser');
  expect(openBrowser).toHaveBeenCalledOnce();
  expect(githubAppStatus).toHaveBeenCalledOnce(); // Opening the browser does not finish installation.
  expect(screen.queryByText(prefix + 'connected')).toBeNull();
  fireEvent(window, new Event('focus'));
  fireEvent(window, new Event('focus'));
  expect(githubAppStatus).toHaveBeenCalledTimes(2);
  expect(screen.getByText(action === 'connect' ? checking : prefix + 'syncing')).toBeTruthy();
  expect(screen.queryByText(prefix + 'connected')).toBeNull();
  await act(async () => complete({ available: true, login: 'example-user', repositories: ['example/project'] }));
  expect(screen.getByText(prefix + 'connected')).toBeTruthy();
  expect(screen.queryByText(prefix + 'connect')).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
});
it('hides unconfigured service but makes a connection failure visible', async () => {
  const githubAppStatus = vi.fn(async () => ({ available: false }));
  window.electronAPI = { gitContext: { githubAppStatus } } as unknown as typeof window.electronAPI;
  render(<GithubAppCard />);
  await waitFor(() => expect(githubAppStatus).toHaveBeenCalledOnce());
  expect(screen.queryByText(prefix + 'connect')).toBeNull();
  githubAppStatus.mockRejectedValue(new Error('network'));
  fireEvent(window, new Event('focus'));
  expect(await screen.findByText(prefix + 'error')).toBeTruthy();
});
