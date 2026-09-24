import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { closeSharedTasksBeforeAccountHandover } from '../sharedTaskAccountBoundary';

function setup() {
  const events: string[] = [];
  const options = {
    closeSharedTasks: vi.fn(async () => { events.push('close'); }),
    releaseOwnership: vi.fn(async () => { events.push('release'); }),
    onClosureFailure: vi.fn(),
    onReleaseFailure: vi.fn(),
  };
  const disposeDatabase = vi.fn(() => { events.push('dispose'); });
  const commitOwner = vi.fn(() => { events.push('commit'); });
  const handover = async () => {
    await closeSharedTasksBeforeAccountHandover(options);
    disposeDatabase();
    commitOwner();
  };
  return { events, options, disposeDatabase, commitOwner, handover };
}

describe('shared-task account boundary cleanup', () => {
  it('closes shares then releases ownership before database disposal and owner commit', async () => {
    const h = setup();
    await h.handover();
    expect(h.events).toEqual(['close', 'release', 'dispose', 'commit']);
    expect(h.options.onClosureFailure).not.toHaveBeenCalled();
    expect(h.options.onReleaseFailure).not.toHaveBeenCalled();
  });

  it.each([false, true])('releases ownership but preserves the old database on closure failure (release fails=%s)', async (releaseFails) => {
    const h = setup();
    const journalError = new Error('journal unavailable');
    const releaseError = new Error('lease unavailable');
    h.options.closeSharedTasks.mockRejectedValueOnce(journalError);
    if (releaseFails) h.options.releaseOwnership.mockRejectedValueOnce(releaseError);
    await expect(h.handover()).rejects.toBe(journalError);
    expect(h.options.releaseOwnership).toHaveBeenCalledOnce();
    expect(h.options.onClosureFailure).toHaveBeenCalledExactlyOnceWith(journalError);
    expect(h.options.onReleaseFailure.mock.calls).toEqual(releaseFails ? [[releaseError]] : []);
    expect(h.disposeDatabase).not.toHaveBeenCalled();
    expect(h.commitOwner).not.toHaveBeenCalled();
    // The retained outgoing profile can make the closure durable on retry.
    await h.handover();
    expect(h.options.closeSharedTasks).toHaveBeenCalledTimes(2);
    expect(h.disposeDatabase).toHaveBeenCalledOnce();
    expect(h.commitOwner).toHaveBeenCalledOnce();
  });

  it('waits for ownership release even when closure has already failed', async () => {
    const h = setup();
    const error = new Error('disk failed');
    let release!: () => void;
    h.options.closeSharedTasks.mockRejectedValue(error);
    h.options.releaseOwnership.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    let completed = false;
    const result = h.handover().catch((failure) => { completed = true; return failure; });
    await vi.waitFor(() => expect(h.options.releaseOwnership).toHaveBeenCalledOnce());
    expect(completed).toBe(false);
    release();
    expect(await result).toBe(error);
    expect(h.disposeDatabase).not.toHaveBeenCalled();
  });

  it('keeps lease-release failure best effort after durable closure', async () => {
    const h = setup();
    const error = new Error('lease unavailable');
    h.options.releaseOwnership.mockRejectedValue(error);
    await h.handover();
    expect(h.options.onReleaseFailure).toHaveBeenCalledExactlyOnceWith(error);
    expect(h.disposeDatabase).toHaveBeenCalledOnce();
    expect(h.commitOwner).toHaveBeenCalledOnce();
  });

  it('wires both bootstrap cleanup sites through the blocking closure before disposing the DB', () => {
    const source = readFileSync(new URL('../../bootstrap-electron.ts', import.meta.url), 'utf8');
    const teardown = source.slice(source.indexOf('async function teardownAuthAccountBoundary('), source.indexOf('authManager.setAccountSwitchTeardown('));
    const sites = [...teardown.matchAll(/await closeSharedTasksBeforeAccountHandover\(\{([\s\S]*?)\}\);/g)];
    expect(sites).toHaveLength(2);
    for (const site of sites) {
      expect(site[1]).toContain('closeSharedTasks: closeSharedTasksBeforeLogout');
      expect(site[1]).toContain('releaseOwnership: releaseDeviceLinkOwnershipBeforeLogout');
      expect(site[1]).toContain('onClosureFailure: () => markAccountBoundaryAbortedMidTeardown(reason)');
      const next = teardown.slice(site.index! + site[0].length).trimStart();
      expect(next).toMatch(/^(?:try \{\s*)?await lifecycleDbClientManager\.dispose\(reason\);/);
    }
    expect(teardown).not.toContain('await closeSharedTasksBeforeLogout()');
  });
});
