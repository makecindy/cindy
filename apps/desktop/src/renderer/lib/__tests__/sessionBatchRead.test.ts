// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSessionBatch, readSessionBatchFor } from '../sessionBatchRead';

const owners = vi.hoisted(() => new Map<string, string>());
vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: (id: string) => owners.get(id) ?? null,
}));
const row = (id: string, status = 'active') => ({
  id, status, title: id, workingDir: null, model: 'model', agentKind: 'cc',
  createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z',
  _count: { messages: 3 }, preview: 'preview',
});
const get = vi.fn();
const getMany = vi.fn();
const invoke = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  owners.clear();
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    localDb: { sessions: { get, getMany } }, deviceLink: { invoke },
  } });
  getMany.mockImplementation(async (ids: string[]) => ids.filter((id) => id !== 'missing').map((id) => row(id)));
  invoke.mockImplementation(async (_device: string, channel: string, [ids]: [string[]]) => {
    expect(channel).toBe('local-db:sessions:get-many');
    return ids.filter((id) => id !== 'missing').map((id) => row(id));
  });
});
afterEach(() => { delete (window as unknown as Record<string, unknown>).electronAPI; });

describe('shared local and remote metadata reads', () => {
  it('uses the same projection, missing semantics and deduplication for either transport', async () => {
    const ids = ['first', 'missing', 'first'];
    const local = await readSessionBatch(ids);
    const remote = await readSessionBatch(ids, 'desktop');
    expect(local).toEqual(remote);
    expect(local).toEqual([{ sessionId: 'first', value: row('first') }, { sessionId: 'missing', errorCode: 'NOT_FOUND' }]);
    expect(getMany).toHaveBeenCalledExactlyOnceWith(['first', 'missing']);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('desktop', 'local-db:sessions:get-many', [['first', 'missing']]);
    expect(get).not.toHaveBeenCalled();
  });

  it.each([undefined, 'desktop'])('bounds batches identically for target %s', async (device) => {
    const ids = Array.from({ length: 70 }, (_, index) => `s${index}`);
    const result = await readSessionBatch(ids, device);
    expect(result.map((item) => item.sessionId)).toEqual(ids);
    const chunks = device ? invoke.mock.calls.map((call) => call[2][0]) : getMany.mock.calls.map((call) => call[0]);
    expect(chunks.map((chunk) => chunk.length)).toEqual([32, 32, 6]);
  });

  it.each([undefined, 'desktop'])('does not turn malformed replies or whole-batch errors into deletions for %s', async (device) => {
    const batch = device ? invoke : getMany;
    for (const value of [[row('unrequested')], [row('s'), row('s')], [{ id: 's' }]]) {
      batch.mockResolvedValueOnce(value);
      expect(await readSessionBatch(['s'], device)).toEqual([{ sessionId: 's' }]);
    }
    batch.mockRejectedValueOnce(new Error('[NOT_FOUND] Batch unavailable'));
    expect(await readSessionBatch(['s'], device)).toEqual([{ sessionId: 's', errorCode: undefined }]);
    expect(get).not.toHaveBeenCalled();
  });

  it('captures each target and keeps local ids out of remote requests and vice versa', async () => {
    owners.set('remote', 'desktop');
    const results = await readSessionBatchFor(['local', 'remote', 'remote']);
    expect(results).toHaveLength(2);
    expect(getMany).toHaveBeenCalledExactlyOnceWith(['local']);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('desktop', 'local-db:sessions:get-many', [['remote']]);
  });

  it('does not cache settled rows across reads', async () => {
    await readSessionBatch(['s']);
    getMany.mockResolvedValueOnce([row('s', 'archived')]);
    expect((await readSessionBatch(['s']))[0].value?.status).toBe('archived');
    expect(getMany).toHaveBeenCalledTimes(2);
  });
});
