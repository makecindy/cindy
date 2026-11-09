import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../secrets/providerSecretStore', () => ({ readGhostSecret: vi.fn() }));
vi.mock('../maker-host/outbound-fetch', () => ({ outboundFetch: vi.fn() }));
vi.mock('../appSessionState', () => ({ activeOwnerScopeKey: () => 'test-owner' }));
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  guard: vi.fn(),
  start: vi.fn(),
  invalidate: vi.fn(),
  send: vi.fn(),
  readToken: vi.fn(),
  disposers: [] as Array<() => void>,
  connected: undefined as undefined | (() => void),
  focused: null as null | { isDestroyed(): boolean; webContents: { send(channel: string): void } },
  secondary: null as null | { isDestroyed(): boolean; webContents: { send(channel: string): void } },
  main: null as null | { isDestroyed(): boolean; webContents: { send(channel: string): void } },
}));
vi.mock('../deepLink', () => ({ getDeepLinkMainWindow: () => mocks.main }));
vi.mock('../secondary-windows', () => ({ isSecondaryAppWindow: (win: unknown) => win === mocks.secondary }));
vi.mock('electron', () => ({
  app: { getPath: () => '/test/userData', once: (_event: string, dispose: () => void) => mocks.disposers.push(dispose) },
  ipcMain: {
    handle: (name: string, fn: (...args: any[]) => unknown) => mocks.handlers.set(name, fn),
  },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }],
    getFocusedWindow: () => mocks.focused,
  },
}));
vi.mock('../security/trustedAppRenderer', () => ({ assertTrustedAppRendererEvent: mocks.guard }));
vi.mock('../git-context/ghBinary', () => ({ configureManagedGhRoot: vi.fn() }));
vi.mock('../git-context/ghCliTokenSource', () => ({
  getSharedGhCliTokenSource: () => ({ invalidate: mocks.invalidate, readToken: mocks.readToken }),
}));
vi.mock('../git-context/githubSetup', () => ({
  createGithubSetup: (_root: string, connected: () => void) => {
    mocks.connected = connected;
    return { start: mocks.start, snapshot: () => ({ phase: 'idle' }), cancel: vi.fn() };
  },
}));
import { openGithubSignIn, readGithubConnection, registerGithubSetupIpc } from '../git-context/githubSetupIpc';
import { readGhostSecret } from '../secrets/providerSecretStore';
import { outboundFetch } from '../maker-host/outbound-fetch';
import { getGhostSetupChangeBus } from '../cindy-brain/ghostSetupChangeBus';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readGhostSecret).mockReset();
  vi.mocked(outboundFetch).mockReset();
  mocks.readToken.mockResolvedValue(null);
});
afterEach(() => mocks.disposers.splice(0).forEach(dispose => dispose()));

describe('GitHub setup IPC boundary', () => {
  it.each(['cindy-github', '_root__cindy-github'])(
    'verifies the PAT and refreshes connected windows for %s', async (instanceId) => {
      const invalidate = vi.fn();
      vi.mocked(readGhostSecret).mockImplementation((id) => id === instanceId ? 'synthetic-pat' : null);
      vi.mocked(outboundFetch).mockResolvedValue(new Response('{"login":"test-user"}'));
      registerGithubSetupIpc(invalidate);
      const connection = mocks.handlers.get('git-context:github-setup:connection')!;
      await expect(connection({})).resolves.toEqual({ status: 'connected', source: 'token', login: 'test-user' });
      expect(outboundFetch).toHaveBeenCalledWith('https://api.github.com/user',
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer synthetic-pat' }) }));
      getGhostSetupChangeBus().emit(instanceId, { source: 'secret', ref: 'github_pat' });
      expect(invalidate).toHaveBeenCalledOnce();
      expect(mocks.send).toHaveBeenCalledWith('git-context:github-connected');
    },
  );
  it('does not verify or subscribe to a same-name enterprise credential', async () => {
    const instanceId = '_ns__acme__cindy-github';
    vi.mocked(readGhostSecret).mockImplementation((id) => id === instanceId ? 'synthetic-enterprise-pat' : null);
    registerGithubSetupIpc(vi.fn());
    const connection = mocks.handlers.get('git-context:github-setup:connection')!;
    await expect(connection({})).resolves.toEqual({ status: 'missing' });
    getGhostSetupChangeBus().emit(instanceId, { source: 'secret', ref: 'github_pat' });
    expect(outboundFetch).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('rejects untrusted callers and arbitrary payloads before invoking the installer', () => {
    registerGithubSetupIpc(vi.fn());
    const start = mocks.handlers.get('git-context:github-setup:start')!;
    mocks.guard.mockImplementationOnce(() => {
      throw new Error('untrusted');
    });
    expect(() => start({})).toThrow('untrusted');
    expect(() => start({}, { url: 'https://attacker.test/tool' })).toThrow();
    expect(mocks.start).not.toHaveBeenCalled();
    start({});
    expect(mocks.start).toHaveBeenCalledOnce();
  });
  it('clears both caches before notifying every window', () => {
    const invalidate = vi.fn();
    registerGithubSetupIpc(invalidate);
    mocks.connected!();
    expect(mocks.invalidate).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenCalledWith('git-context:github-connected');
    expect(invalidate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.send.mock.invocationCallOrder[0],
    );
  });
});

// Rule (2026-11-06, plan D): connect_account for the GitHub plugin opens Cindy's sign-in in the window
// the user is looking at, else the main window; with no window it reports that nothing opened (unit).
it('opens the GitHub sign-in in the focused window, then the main window', () => {
  const focusedSend = vi.fn();
  const mainSend = vi.fn();
  mocks.main = { isDestroyed: () => false, webContents: { send: mainSend } };
  mocks.focused = { isDestroyed: () => false, webContents: { send: focusedSend } };
  mocks.secondary = mocks.focused;
  expect(openGithubSignIn()).toBe(true);
  expect(focusedSend).toHaveBeenCalledWith('git-context:github-setup:open');
  // Review (Codex P2 on #9022): a focused window that does not mount the App (a detached sidebar window)
  // would swallow the request, so it goes to the main window instead; a secondary App window is fine.
  focusedSend.mockClear();
  mainSend.mockClear();
  expect(openGithubSignIn()).toBe(true);
  expect(focusedSend).toHaveBeenCalledTimes(1);
  mocks.secondary = null;
  const sidebarSend = vi.fn();
  mocks.focused = { isDestroyed: () => false, webContents: { send: sidebarSend } };
  expect(openGithubSignIn()).toBe(true);
  expect(sidebarSend).not.toHaveBeenCalled();
  expect(mainSend).toHaveBeenCalledTimes(1);
  mocks.focused = null;
  expect(openGithubSignIn()).toBe(true);
  expect(mainSend).toHaveBeenCalledWith('git-context:github-setup:open');
  mocks.main = null;
  expect(openGithubSignIn()).toBe(false);
});

// Review (Codex P2 on #9022): with no gh login, the fallback token read must be the requested
// plugin's own secret, never the GitHub plugin's. Minimal input: a token only under the GitHub plugin (unit).
it('reads only the requested plugin\'s fallback token when one is given', async () => {
  vi.mocked(readGhostSecret).mockImplementation(((id: string, key: string) =>
    id === 'cindy-github' && key === 'github_pat' ? 'ghp_github_plugin' : null) as never);
  expect(await readGithubConnection({ instanceId: 'other-plugin', key: 'token' })).toEqual({ status: 'missing' });
  expect(outboundFetch).not.toHaveBeenCalled();
  expect(readGhostSecret).toHaveBeenCalledWith('other-plugin', 'token');
  expect(readGhostSecret).not.toHaveBeenCalledWith('cindy-github', 'github_pat');
});
