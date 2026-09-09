// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type FileTreeEvent = { workdir: string; relPath: string };
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const mocks = vi.hoisted(() => {
  const eventCallbacks: Array<(event: FileTreeEvent) => void> = [];
  return {
    eventCallbacks,
    fileBrowserApiFor: vi.fn(),
    isDeviceTooOldError: vi.fn(() => false),
    listDir: vi.fn(),
    loadExpandedSet: vi.fn(() => new Set<string>()),
    onFileTreeEventFor: vi.fn(
      (_deviceId: string | null | undefined, cb: (event: FileTreeEvent) => void) => {
        eventCallbacks.push(cb);
        return () => {
          const index = eventCallbacks.indexOf(cb);
          if (index >= 0) eventCallbacks.splice(index, 1);
        };
      },
    ),
    saveExpandedSet: vi.fn(),
    startWatchFor: vi.fn(async () => undefined),
    stopWatchFor: vi.fn(async () => undefined),
  };
});

vi.mock('@/lib/fileBrowserTransport', () => ({
  fileBrowserApiFor: mocks.fileBrowserApiFor,
  isDeviceTooOldError: mocks.isDeviceTooOldError,
  onFileTreeEventFor: mocks.onFileTreeEventFor,
  startWatchFor: mocks.startWatchFor,
  stopWatchFor: mocks.stopWatchFor,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

vi.mock('../../lib/expandedStore', () => ({
  loadExpandedSet: mocks.loadExpandedSet,
  saveExpandedSet: mocks.saveExpandedSet,
}));

import { useFileTree, type DirEntry } from '../useFileTree';

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('useFileTree refresh scheduling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventCallbacks.length = 0;
    mocks.fileBrowserApiFor.mockReturnValue({ listDir: mocks.listDir });
  });

  it('limits a directory refresh to one trailing scan during a watcher storm', async () => {
    const entries: readonly DirEntry[] = [
      { name: 'src', relPath: 'src', type: 'directory', size: 0, mtimeMs: 1 },
    ];
    const pending: Array<Deferred<readonly DirEntry[]>> = [];
    mocks.listDir.mockImplementation(() => {
      if (mocks.listDir.mock.calls.length === 1) return Promise.resolve(entries);
      const request = deferred<readonly DirEntry[]>();
      pending.push(request);
      return request.promise;
    });

    const view = renderHook(() => useFileTree({ workdir: '/workdir' }));
    await waitFor(() => expect(view.result.current.initialLoading).toBe(false));
    expect(mocks.listDir).toHaveBeenCalledTimes(1);
    const emitEvent = mocks.eventCallbacks[0];
    expect(emitEvent).toBeDefined();

    await act(async () => {
      emitEvent({ workdir: '/workdir', relPath: 'first.md' });
      await new Promise((resolve) => setTimeout(resolve, 70));
    });
    expect(mocks.listDir).toHaveBeenCalledTimes(2);

    await act(async () => {
      emitEvent({ workdir: '/workdir', relPath: 'second.md' });
      await new Promise((resolve) => setTimeout(resolve, 70));
    });
    pending[0].resolve(entries);
    await waitFor(() => expect(mocks.listDir).toHaveBeenCalledTimes(3));

    await act(async () => {
      for (let i = 0; i < 10; i += 1) {
        emitEvent({ workdir: '/workdir', relPath: `storm-${i}.md` });
      }
      await new Promise((resolve) => setTimeout(resolve, 70));
    });
    expect(mocks.listDir).toHaveBeenCalledTimes(3);

    await act(async () => {
      pending[1].resolve(entries);
      await Promise.resolve();
    });
    await waitFor(() => expect(view.result.current.loadingPaths.size).toBe(0));
    expect(mocks.listDir).toHaveBeenCalledTimes(3);

    view.unmount();
  });
});
