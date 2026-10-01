import { describe, expect, it, vi } from 'vitest';
vi.mock('../secrets/providerSecretStore', () => ({ readGhostSecret: vi.fn() }));
vi.mock('../maker-host/outbound-fetch', () => ({ outboundFetch: vi.fn() }));
vi.mock('../appSessionState', () => ({ activeOwnerScopeKey: () => 'test-owner' }));
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  guard: vi.fn(),
  start: vi.fn(),
  invalidate: vi.fn(),
  send: vi.fn(),
  connected: undefined as undefined | (() => void),
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/test/userData', once: vi.fn() },
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
  getSharedGhCliTokenSource: () => ({ invalidate: mocks.invalidate }),
}));
vi.mock('../git-context/githubSetup', () => ({
  createGithubSetup: (_root: string, connected: () => void) => {
    mocks.connected = connected;
    return { start: mocks.start, snapshot: () => ({ phase: 'idle' }), cancel: vi.fn() };
  },
}));
import { registerGithubSetupIpc } from '../git-context/githubSetupIpc';

describe('GitHub setup IPC boundary', () => {
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
