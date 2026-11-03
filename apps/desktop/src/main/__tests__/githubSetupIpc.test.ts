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
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/test/userData', once: (_event: string, dispose: () => void) => mocks.disposers.push(dispose) },
  ipcMain: {
    handle: (name: string, fn: (...args: any[]) => unknown) => mocks.handlers.set(name, fn),
  },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }],
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
import { registerGithubSetupIpc } from '../git-context/githubSetupIpc';
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
