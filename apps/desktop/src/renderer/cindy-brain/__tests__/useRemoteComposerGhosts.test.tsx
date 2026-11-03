// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRemoteComposerGhosts } from '../useRemoteComposerGhosts';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { sharedTaskHostPeer } from '@cindy/device-link';

const invoke = vi.fn();
const catalog = (id: string) => [{ manifest: { id, name: id, command: id }, enabled: true }];
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  invoke.mockReset();
  setDataOwnerGeneration('owner');
  Object.assign(window, { electronAPI: { deviceLink: { invoke } } });
});
afterEach(cleanup);

describe('remote composer plugins', () => {
  it('omits directory arguments for a folderless remote draft', async () => {
    invoke.mockResolvedValue(catalog('remote'));
    const { result } = renderHook(() => useRemoteComposerGhosts('a', undefined, true, 0));
    await waitFor(() => expect(result.current.ghosts[0]?.manifest.id).toBe('remote'));
    // JSON transport would turn [undefined] into [null], which the host rejects.
    expect(invoke).toHaveBeenCalledExactlyOnceWith('a', 'ghosts:composer-list', []);
  });
  it('renders immediately and drops late responses after switching device or directory', async () => {
    const old = deferred();
    const next = deferred();
    invoke
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(next.promise)
      .mockResolvedValue(catalog('project'));
    const { result, rerender } = renderHook(
      ({ device, dir }) => useRemoteComposerGhosts(device, dir, false, 0),
      { initialProps: { device: 'a', dir: '/a' } },
    );
    expect(result.current.ghosts).toEqual([]);
    rerender({ device: 'b', dir: '/b' });
    await act(async () => {
      next.resolve(catalog('b'));
    });
    expect(result.current.ghosts[0]?.manifest.id).toBe('b');
    await act(async () => {
      old.resolve(catalog('a'));
    });
    expect(result.current.ghosts[0]?.manifest.id).toBe('b');
    rerender({ device: 'b', dir: '/project' });
    expect(result.current.ghosts).toEqual([]);
    await waitFor(() => expect(result.current.ghosts[0]?.manifest.id).toBe('project'));
    expect(invoke).toHaveBeenLastCalledWith('b', 'ghosts:composer-list', ['/project']);
  });

  it('retries failed/old-host responses, refreshes on open/reconnect, and does not fetch on close', async () => {
    invoke
      .mockRejectedValueOnce(new Error('CHANNEL_NOT_ALLOWED'))
      .mockResolvedValue(catalog('remote'));
    const { result, rerender } = renderHook(
      ({ open, epoch }) => useRemoteComposerGhosts('a', undefined, open, epoch),
      { initialProps: { open: false, epoch: 0 } },
    );
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.ghosts).toEqual([]);
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.ghosts[0]?.manifest.id).toBe('remote'));
    rerender({ open: true, epoch: 0 });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
    rerender({ open: false, epoch: 0 });
    expect(invoke).toHaveBeenCalledTimes(3);
    rerender({ open: false, epoch: 1 });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(4));
  });

  it('rejects malformed payloads and does not fall back to local plugins', async () => {
    invoke.mockResolvedValue({ ghosts: catalog('local') });
    const { result } = renderHook(() => useRemoteComposerGhosts('a', '/a', false, 0));
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.ghosts).toEqual([]);
  });

  it('ignores an in-flight response after the account changes', async () => {
    const pending = deferred();
    invoke.mockReturnValue(pending.promise);
    const { result } = renderHook(() => useRemoteComposerGhosts('a', '/a', false, 0));
    setDataOwnerGeneration('another-owner');
    await act(async () => {
      pending.resolve(catalog('private'));
    });
    expect(result.current.ghosts).toEqual([]);
  });

  it('does not request a local or unresolved device catalog', () => {
    const { rerender } = renderHook(
      ({ device }: { device: string | null | undefined }) =>
        useRemoteComposerGhosts(device, '/a', true, 0),
      { initialProps: { device: null as string | null | undefined } },
    );
    rerender({ device: undefined });
    rerender({ device: sharedTaskHostPeer('task', 'host') });
    expect(invoke).not.toHaveBeenCalled();
  });
});
