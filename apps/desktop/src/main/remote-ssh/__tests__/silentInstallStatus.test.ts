import {createSshAgentInstaller} from '@cindy/app-runtime/sshAgentInstaller';
import { describe, expect, it, vi } from 'vitest';
import { prepareRemoteAgentInstall } from '../codex-install-lifecycle.js';

const {probe}=vi.hoisted(()=>({probe:vi.fn()}));
vi.mock('@cindy/maker-remote-ssh',async importOriginal=>({...await importOriginal<typeof import('@cindy/maker-remote-ssh')>(),probeRemoteAgent:probe}));

function harness(install: (...args: any[]) => Promise<unknown>) {
  const status=vi.fn();
  probe.mockResolvedValue({installed:false,installedVersion:null});
  const log={trace:vi.fn(),debug:vi.fn(),info:vi.fn(),warn:vi.fn(),error:vi.fn(),fatal:vi.fn(),child:()=>log};
  const runtime=createSshAgentInstaller({getPool:()=>new Map([['builder',{getStatus:()=> 'ready'} as unknown as import('@cindy/maker-remote-ssh').RemoteHost]]),log,
    installRemoteAgent:install as import('@cindy/app-runtime/sshAgentInstaller').SshAgentInstallerHost['installRemoteAgent'],broadcastSilentInstallStatus:status,broadcastInstallProgress:vi.fn()});
  return {run:()=>runtime.ensureRemoteAgentInstalledOrInstall('builder','codex'),status,cache:runtime.remoteAgentInstalledCache,inFlight:runtime.inFlightInstall};
}

describe('silent installation terminal status', () => {
  it.each(['live turn', 'daemon stop failure'])('ends a %s preflight failure and permits retry', async (reason) => {
    const deps = {
      isInstalled: async () => false,
      hasLiveTurn: vi.fn(() => reason === 'live turn'),
      stopDaemon: vi.fn(async () => ({ ok: reason !== 'daemon stop failure' })),
    };
    const installPackage = vi.fn(async () => ({ ready: true, installedVersion: 'managed' }));
    const h = harness(async () => {
      await prepareRemoteAgentInstall('codex', deps);
      return installPackage();
    });
    const error = await h.run().catch((err: Error) => err);
    expect(error).toMatchObject({ code: 'SSH_INSTALL_FAILED' });
    expect(h.status.mock.calls.map(([event]) => event)).toEqual([
      { hostId: 'builder', agentKind: 'codex', phase: 'started' },
      { hostId: 'builder', agentKind: 'codex', phase: 'failed', message: error.message },
    ]);
    expect(installPackage).not.toHaveBeenCalled();
    if (reason === 'live turn') expect(deps.stopDaemon).not.toHaveBeenCalled();
    expect(h.cache.size).toBe(0);
    expect(h.inFlight.size).toBe(0);

    deps.hasLiveTurn.mockReturnValue(false);
    deps.stopDaemon.mockResolvedValue({ ok: true });
    h.status.mockClear();
    await expect(h.run()).resolves.toMatchObject({ ready: true });
    expect(h.status.mock.calls.map(([event]) => event.phase)).toEqual(['started', 'done']);
    expect(installPackage).toHaveBeenCalledOnce();
    expect(h.cache.get('builder').get('codex')).toEqual({ installedVersion: 'managed' });
    expect(h.inFlight.size).toBe(0);
  });

  it('emits one failure with the diagnostic log tail for a not-ready result', async () => {
    const h = harness(async (_host, _kind, progress) => {
      progress({ kind: 'install-log', line: 'curl: HTTP 403' });
      return { ready: false, error: 'download failed' };
    });
    await expect(h.run()).rejects.toMatchObject({
      code: 'SSH_INSTALL_FAILED', message: '[SSH_INSTALL_FAILED] download failed\ncurl: HTTP 403',
    });
    expect(h.status.mock.calls.map(([event]) => event.phase)).toEqual(['started', 'progress', 'failed']);
    expect(h.status).toHaveBeenLastCalledWith({
      hostId: 'builder', agentKind: 'codex', phase: 'failed', message: 'download failed\ncurl: HTTP 403',
    });
    expect(h.inFlight.size).toBe(0);
  });

  it.each([undefined, 'STREAM_CLOSED'])('ends unexpected errors (%s) while preserving INTERNAL mapping', async (code) => {
    const h = harness(async () => { throw Object.assign(new Error('transport closed'), { code }); });
    await expect(h.run()).rejects.toMatchObject({ code: 'INTERNAL', message: '[INTERNAL] transport closed' });
    expect(h.status.mock.calls.map(([event]) => event.phase)).toEqual(['started', 'failed']);
    expect(h.status).toHaveBeenLastCalledWith({
      hostId: 'builder', agentKind: 'codex', phase: 'failed', message: 'transport closed',
    });
    expect(h.inFlight.size).toBe(0);
  });
});
