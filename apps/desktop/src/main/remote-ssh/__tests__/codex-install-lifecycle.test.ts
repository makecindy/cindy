import { describe, expect, it, vi } from 'vitest';
import { prepareRemoteAgentInstall } from '../codex-install-lifecycle.js';

describe('Codex package upgrade daemon lifecycle', () => {
  const deps = () => ({ isInstalled: vi.fn(async () => false), hasLiveTurn: vi.fn(() => false),
    stopDaemon: vi.fn(async () => ({ ok: true })) });
  it('stops the old daemon before permitting package replacement', async () => {
    const d = deps();
    await prepareRemoteAgentInstall('codex', d);
    expect(d.stopDaemon).toHaveBeenCalledOnce();
    expect(d.isInstalled.mock.invocationCallOrder[0]).toBeLessThan(d.stopDaemon.mock.invocationCallOrder[0]!);
  });
  it('does not stop a current package daemon or affect other engines', async () => {
    const d = deps();
    d.isInstalled.mockResolvedValue(true);
    await prepareRemoteAgentInstall('codex', d);
    await prepareRemoteAgentInstall('claude-code', d);
    await prepareRemoteAgentInstall('pi', d);
    expect(d.isInstalled).toHaveBeenCalledOnce();
    expect(d.stopDaemon).not.toHaveBeenCalled();
  });
  it('defers the upgrade during a live turn and supports retry after it ends', async () => {
    const d = deps();
    d.hasLiveTurn.mockReturnValue(true);
    await expect(prepareRemoteAgentInstall('codex', d)).rejects.toThrow('deferred');
    expect(d.stopDaemon).not.toHaveBeenCalled();
    d.hasLiveTurn.mockReturnValue(false);
    await prepareRemoteAgentInstall('codex', d);
    expect(d.stopDaemon).toHaveBeenCalledOnce();
  });
  it('refuses to proceed if the old daemon survives shutdown', async () => {
    const d = deps();
    d.stopDaemon.mockResolvedValue({ ok: false });
    await expect(prepareRemoteAgentInstall('codex', d)).rejects.toThrow('Unable to stop');
  });
});
