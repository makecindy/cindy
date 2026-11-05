// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCachedFileContent } from '../../lib/fileContentCache';

const { readFile, fetchRemote, cachePut, subscribe } = vi.hoisted(() => ({
  readFile: vi.fn(),
  fetchRemote: vi.fn(),
  cachePut: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock('@/lib/fileBrowserTransport', () => ({
  fileBrowserApiFor: () => ({ readFile }),
  onFileTreeEventFor: subscribe,
}));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
import { useFileContent } from '../useFileContent';

// Test value: production hook must hand remote XML XLS to the cached Office
// reader, not a text editor (PR #8810 / attachment-preview.md source contract).
// Existing file-content-state tests only project state; parser tests never drive
// transport/cache/watch lifecycles. Minimal input is one small untruncated XML
// .xls, including an existing text-cache entry. Unit, in-memory transport only.
const text = { content: '<Workbook/>', relPath: 'book.xls', size: 11, mtimeMs: 1, truncated: false };
let onChange: (event: { workdir: string; relPath: string; type: 'change' }) => void;

beforeEach(() => {
  vi.clearAllMocks();
  readFile.mockResolvedValue({ ok: true, data: text });
  fetchRemote.mockResolvedValue({ ok: true, cachePath: '/cache/office-copy' });
  subscribe.mockImplementation((_device, listener) => {
    onChange = listener;
    return () => {};
  });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      fileBrowser: {
        fetchRemote,
        cachePut,
        onTransferProgress: () => () => {},
      },
    },
  });
});
afterEach(cleanup);

describe('remote Office text routing', () => {
  it.each([
    { remoteHostId: 'ssh-host', deviceId: null, seedTextCache: false },
    { remoteHostId: null, deviceId: 'peer-device', seedTextCache: true },
  ])('fetches a binary copy and refreshes it on change: $remoteHostId / $deviceId', async ({ remoteHostId, deviceId, seedTextCache }) => {
    if (seedTextCache) setCachedFileContent(`dev:${deviceId}|/repo`, text);
    const { result } = renderHook(() => useFileContent('/repo', 'book.xls', remoteHostId, deviceId));
    await waitFor(() => expect(result.current.content.kind).toBe('cached'));
    expect(result.current.content).toMatchObject({
      stat: { relPath: 'book.xls', size: 11, mtimeMs: 1 },
      cachePath: '/cache/office-copy',
    });
    expect(fetchRemote).toHaveBeenCalledWith(expect.objectContaining({
      workdir: '/repo', relPath: 'book.xls', remoteHostId, deviceId, size: 11, mtimeMs: 1,
    }));
    expect(cachePut).not.toHaveBeenCalled();

    readFile.mockResolvedValueOnce({ ok: true, data: { ...text, mtimeMs: 2 } });
    fetchRemote.mockResolvedValueOnce({ ok: true, cachePath: '/cache/updated-copy' });
    act(() => onChange({ workdir: '/repo', relPath: 'book.xls', type: 'change' }));
    await waitFor(() => expect(result.current.content).toMatchObject({
      kind: 'cached', stat: { mtimeMs: 2 }, cachePath: '/cache/updated-copy',
    }));
  });

  it.each(['response', 'rejection'])('shows fetch failure without a second request or XML source: %s', async (failure) => {
    if (failure === 'response') fetchRemote.mockResolvedValueOnce({ ok: false, message: 'fetch failed' });
    else fetchRemote.mockRejectedValueOnce(new Error('fetch failed'));
    const { result } = renderHook(() => useFileContent('/repo', 'book.xls', 'ssh-host'));
    await waitFor(() => expect(result.current.content).toEqual({
      kind: 'error', message: failure === 'response' ? 'fetch failed' : 'Error: fetch failed',
    }));
    expect(fetchRemote).toHaveBeenCalledTimes(1);
  });

  it('keeps ordinary remote text inline', async () => {
    readFile.mockResolvedValueOnce({ ok: true, data: { ...text, relPath: 'note.txt' } });
    const { result } = renderHook(() => useFileContent('/repo', 'note.txt', 'ssh-host'));
    await waitFor(() => expect(result.current.content).toMatchObject({ kind: 'text', relPath: 'note.txt' }));
    expect(fetchRemote).not.toHaveBeenCalled();
    expect(cachePut).toHaveBeenCalledTimes(1);
  });

  it('ignores a cached-copy response from the previous endpoint', async () => {
    let resolveOld!: (value: { ok: true; cachePath: string }) => void;
    fetchRemote.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
    const view = renderHook(({ host }) => useFileContent('/repo', 'book.xls', host), { initialProps: { host: 'old-host' } });
    await waitFor(() => expect(view.result.current.content.kind).toBe('fetching'));
    view.rerender({ host: 'new-host' });
    await waitFor(() => expect(view.result.current.content.kind).toBe('cached'));
    await act(async () => resolveOld({ ok: true, cachePath: '/cache/old-copy' }));
    expect(view.result.current.content).toMatchObject({ kind: 'cached', cachePath: '/cache/office-copy' });
  });
});
