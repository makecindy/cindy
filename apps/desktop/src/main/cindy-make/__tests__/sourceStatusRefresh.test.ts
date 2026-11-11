import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { MakeSourceStatus } from '../../../shared/cindyMakeDoctor.js';
import { CindyMakeManager } from '../manager.js';
import { refreshCindySourceStatus } from '../sourceStatusRefresh.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const summary: MakeSourceStatus = {
  status: 'ready',
  path: path.resolve('managed', 'source'),
  channel: 'dev',
  ref: 'main',
};
const local: MakeSourceStatus = {
  ...summary,
  branch: 'cindy-personal',
  mainCommit: 'a'.repeat(40),
};
const latest: MakeSourceStatus = {
  ...local,
  latestVersion: {
    status: 'ready',
    channel: 'dev',
    ref: 'main',
    commit: 'b'.repeat(40),
    behind: 2,
    ahead: 0,
  },
};

function harness() {
  const manager = new CindyMakeManager();
  const disk = deferred<MakeSourceStatus>();
  const git = deferred<MakeSourceStatus>();
  const network = deferred<MakeSourceStatus>();
  const readers = {
    readSummary: vi.fn(() => disk.promise),
    readLocal: vi.fn(() => git.promise),
    readLatest: vi.fn((_source: MakeSourceStatus) => network.promise),
  };
  return { manager, disk, git, network, readers };
}

describe('source status refresh', () => {
  it.each(['ready', 'unavailable'] as const)(
    'publishes disk and Git details before the network returns %s',
    async (status) => {
      const h = harness();
      const published: (MakeSourceStatus | undefined)[] = [];
      h.manager.subscribe((state) => published.push(state.source));
      const result = refreshCindySourceStatus(h.manager, h.readers);
      h.disk.resolve(summary);
      await vi.waitFor(() => expect(h.readers.readLocal).toHaveBeenCalledOnce());
      expect(h.manager.getState().source).toEqual(summary);
      expect(published).toContainEqual(summary);
      expect(h.readers.readLatest).not.toHaveBeenCalled();
      h.git.resolve(local);
      await vi.waitFor(() => expect(h.readers.readLatest).toHaveBeenCalledWith(local));
      expect(h.manager.getState().source).toEqual(local);
      expect(published).toContainEqual(local);
      const final =
        status === 'ready'
          ? latest
          : {
              ...local,
              latestVersion: { status, channel: 'dev' as const },
            };
      h.network.resolve(final);
      await expect(result).resolves.toEqual(final);
      expect(h.manager.getState().source).toEqual(final);
    },
  );

  it.each(['disk', 'git', 'network'] as const)(
    'cannot overwrite preparation or a subsequent clear after waiting for %s',
    async (stage) => {
      const h = harness();
      const result = refreshCindySourceStatus(h.manager, h.readers);
      if (stage !== 'disk') {
        h.disk.resolve(summary);
        await vi.waitFor(() => expect(h.readers.readLocal).toHaveBeenCalledOnce());
      }
      if (stage === 'network') {
        h.git.resolve(local);
        await vi.waitFor(() => expect(h.readers.readLatest).toHaveBeenCalledOnce());
      }
      h.manager.setSourceStatus({ ...summary, status: 'preparing', phase: 'cloning' });
      const cleared: MakeSourceStatus = { status: 'missing', path: summary.path };
      h.manager.setSourceStatus(cleared);
      h.disk.resolve(summary);
      h.git.resolve(local);
      h.network.resolve(latest);
      await expect(result).resolves.toEqual(cleared);
      expect(h.manager.getState().source).toEqual(cleared);
      if (stage === 'disk') expect(h.readers.readLocal).not.toHaveBeenCalled();
      if (stage !== 'network') expect(h.readers.readLatest).not.toHaveBeenCalled();
    },
  );

  it('keeps a newer refresh when an older network request finishes last', async () => {
    const h = harness();
    const old = refreshCindySourceStatus(h.manager, h.readers);
    h.disk.resolve(summary);
    h.git.resolve(local);
    await vi.waitFor(() => expect(h.readers.readLatest).toHaveBeenCalledOnce());
    const newer = { ...local, mainCommit: 'c'.repeat(40) };
    await refreshCindySourceStatus(h.manager, {
      readSummary: async () => summary,
      readLocal: async () => newer,
      readLatest: async (source) => source,
    });
    h.network.resolve(latest);
    await expect(old).resolves.toEqual(newer);
    expect(h.manager.getState().source).toEqual(newer);
  });

  it('invalidates an older lookup as soon as a newer refresh starts', async () => {
    const h = harness();
    const old = refreshCindySourceStatus(h.manager, h.readers);
    h.disk.resolve(summary);
    h.git.resolve(local);
    await vi.waitFor(() => expect(h.readers.readLatest).toHaveBeenCalledOnce());
    const newSummary = deferred<MakeSourceStatus>();
    const newer = { ...local, mainCommit: 'c'.repeat(40) };
    const current = refreshCindySourceStatus(h.manager, {
      readSummary: () => newSummary.promise,
      readLocal: async () => newer,
      readLatest: async (source) => source,
    });
    h.network.resolve(latest);
    await expect(old).resolves.toEqual(local);
    expect(h.manager.getState().source).toEqual(local);
    newSummary.resolve(summary);
    await expect(current).resolves.toEqual(newer);
    expect(h.manager.getState().source).toEqual(newer);
  });

  it.each(['missing', 'preparing', 'cancelled', 'failed'] as const)(
    'publishes %s immediately without discovering tools or checking the network',
    async (status) => {
      const h = harness();
      const result = refreshCindySourceStatus(h.manager, h.readers);
      h.disk.resolve({ ...summary, status });
      await expect(result).resolves.toEqual({ ...summary, status });
      expect(h.readers.readLocal).not.toHaveBeenCalled();
      expect(h.readers.readLatest).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    'retains previous details on reentry; same main commit: %s',
    async (same) => {
      const h = harness();
      h.manager.setSourceStatus(latest);
      const result = refreshCindySourceStatus(h.manager, h.readers);
      h.disk.resolve(summary);
      await vi.waitFor(() => expect(h.readers.readLocal).toHaveBeenCalledOnce());
      expect(h.manager.getState().source).toEqual(latest);
      const fresh = same ? local : { ...local, mainCommit: 'c'.repeat(40) };
      h.git.resolve(fresh);
      await vi.waitFor(() => expect(h.readers.readLatest).toHaveBeenCalledOnce());
      expect(h.manager.getState().source?.latestVersion).toEqual(
        same ? latest.latestVersion : undefined,
      );
      h.network.resolve(fresh);
      await result;
    },
  );

  it('retains the local summary if further inspection fails', async () => {
    const h = harness();
    h.readers.readLocal.mockRejectedValueOnce(new Error('Git unavailable'));
    const result = refreshCindySourceStatus(h.manager, h.readers);
    h.disk.resolve(summary);
    await expect(result).rejects.toThrow('Git unavailable');
    expect(h.manager.getState().source).toEqual(summary);
  });
});
