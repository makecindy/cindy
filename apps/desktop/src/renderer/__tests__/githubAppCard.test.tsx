// @vitest-environment jsdom
// Production UI boundary: connection remains user initiated; unavailable deployments hide the entry.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { GithubAppCard } from '../features/cc-agent/GithubAppCard';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
const prefix = 'ccAgent.gitContext.pr.setup.app.';
it('opens installation only on an explicit click and refreshes when the user returns', async () => {
  const connectGithubApp = vi.fn(async () => {});
  const githubAppStatus = vi.fn(async () => ({ available: true, login: null as string | null }));
  window.electronAPI = { gitContext: { githubAppStatus, connectGithubApp } } as unknown as typeof window.electronAPI;
  render(<GithubAppCard />);
  fireEvent.click(await screen.findByText(prefix + 'connect'));
  await waitFor(() => expect(connectGithubApp).toHaveBeenCalledOnce());
  githubAppStatus.mockResolvedValue({ available: true, login: 'example-user' });
  fireEvent(window, new Event('focus'));
  expect(await screen.findByText(prefix + 'connected')).toBeTruthy();
  expect(screen.queryByText(prefix + 'connect')).toBeNull();
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
