import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({ read: vi.fn(), session: vi.fn(), realpath: vi.fn(), query: vi.fn() }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ query: deps.query }) }));
vi.mock('node:fs/promises', () => ({ realpath: deps.realpath }));
vi.mock('../../cindy-media/blobStore.js', () => ({ parseBlobUrl: (url: string) => url === 'cindy-media://blobs/hash.png' ? { hash: 'hash' } : null }));
vi.mock('../../cindy-media/ledger.js', () => ({ sessionCanRead: deps.read }));
vi.mock('../../localDb/ipc/sessions.js', () => ({ getSessionFsSnapshot: deps.session }));
import { assertSharedTaskMedia } from '../sharedTaskMediaAccess.js';
import type { SharedTaskPeerCapture } from '../sharedTaskDispatch.js';
let current = true;
const capture: SharedTaskPeerCapture = {
  author: { sharedTaskId: 'shared', sessionId: 'task', memberId: 'm', accountId: 'u', displayName: 'Guest' },
  isCurrent: () => current, authorize: () => current,
};
beforeEach(() => {
  vi.resetAllMocks(); current = true;
  deps.realpath.mockImplementation(async (value: string) => path.resolve(value));
  deps.session.mockResolvedValue({ workingDir: path.resolve('workspace'), remoteHostId: null });
  deps.query.mockResolvedValue([]);
});
describe('shared task media access', () => {
  it('allows an exact historical file attachment outside the workdir, never prose or another file', async () => {
    const file = path.resolve('downloads', 'report.pdf');
    const url = 'xdt-file://open?path=' + encodeURIComponent(file);
    deps.query.mockResolvedValue([{ content: JSON.stringify({ text: 'report', files: [{ name: 'report.pdf', path: file }] }) }]);
    await expect(assertSharedTaskMedia(url, capture)).resolves.toEqual({ file });
    expect(deps.query.mock.calls[0][0]).toContain("role = 'user' AND rewind_at IS NULL");
    expect(deps.query.mock.calls[0][1]).toEqual(['task']);
    await expect(assertSharedTaskMedia(url + '.other', capture)).rejects.toThrow('PERMISSION_DENIED');
    deps.query.mockResolvedValue([{ content: JSON.stringify({ text: url }) }]);
    await expect(assertSharedTaskMedia(url, capture)).rejects.toThrow('PERMISSION_DENIED');
  });
  it('rejects a historical attachment replaced by a symlink and revocation during history lookup', async () => {
    const file = path.resolve('downloads', 'report.pdf');
    const url = 'xdt-file://open?path=' + encodeURIComponent(file);
    const rows = [{ content: JSON.stringify({ files: [{ path: file }] }) }];
    deps.query.mockResolvedValue(rows);
    deps.realpath.mockImplementation(async (value: string) => value === file ? path.resolve('other', 'private.pdf') : path.resolve(value));
    await expect(assertSharedTaskMedia(url, capture)).rejects.toThrow('PERMISSION_DENIED');
    deps.realpath.mockImplementation(async (value: string) => path.resolve(value));
    deps.query.mockImplementation(async () => { current = false; return rows; });
    await expect(assertSharedTaskMedia(url, capture)).rejects.toThrow('PERMISSION_DENIED');
  });
  it('allows legacy generated media only when its complete URL occurs in host-authored task history', async () => {
    const url = 'xdt-video://art/clip.mp4';
    deps.query.mockResolvedValue([{ content: JSON.stringify({ text: '[video](' + url + ')' }) }]);
    await assertSharedTaskMedia(url, capture);
    expect(deps.query.mock.calls[0][0]).toContain("role IN ('assistant', 'tool_use', 'tool_result')");
    expect(deps.query.mock.calls[0][1]).toEqual(['task', url]);
    deps.query.mockResolvedValue([{ content: url + '.other' }]);
    await expect(assertSharedTaskMedia(url, capture)).rejects.toThrow('PERMISSION_DENIED');
    deps.query.mockResolvedValue([]);
    await expect(assertSharedTaskMedia(url, capture)).rejects.toThrow('PERMISSION_DENIED');
  });
  it('requires task provenance even for a known managed blob', async () => {
    deps.read.mockResolvedValue(false);
    await expect(assertSharedTaskMedia('cindy-media://blobs/hash.png', capture)).rejects.toThrow('PERMISSION_DENIED');
    deps.read.mockResolvedValue(true);
    await assertSharedTaskMedia('cindy-media://blobs/hash.png', capture);
    expect(deps.read).toHaveBeenLastCalledWith('hash', 'task');
  });
  it('rechecks membership after asynchronous ledger reads', async () => {
    deps.read.mockImplementation(async () => { current = false; return true; });
    await expect(assertSharedTaskMedia('cindy-media://blobs/hash.png', capture)).rejects.toThrow('PERMISSION_DENIED');
  });
  it('permits task workdir media but rejects siblings and symlink escapes', async () => {
    const url = (file: string) => 'xdt-file://local?path=' + encodeURIComponent(path.resolve(file));
    await assertSharedTaskMedia(url('workspace/art.png'), capture);
    await expect(assertSharedTaskMedia(url('other/private.png'), capture)).rejects.toThrow();
    deps.realpath.mockImplementation(async (file: string) => file.endsWith('link.png') ? path.resolve('other/private.png') : path.resolve(file));
    await expect(assertSharedTaskMedia(url('workspace/link.png'), capture)).rejects.toThrow();
  });
  it('requires exact SSH task and host provenance before materialization', async () => {
    deps.session.mockResolvedValue({ workingDir: '/work', remoteHostId: 'ssh' });
    const url = 'xdt-file://local?path=/work/a.png&sessionId=task&remoteHostId=ssh&workdir=/work';
    await assertSharedTaskMedia(url, capture);
    await expect(assertSharedTaskMedia(url.replace('sessionId=task', 'sessionId=other'), capture)).rejects.toThrow();
    await expect(assertSharedTaskMedia('xdt-file://local?path=/work/a.png', capture)).rejects.toThrow();
    expect(deps.realpath).not.toHaveBeenCalled();
  });
  it('keeps legacy task image history scoped to its actual session', async () => {
    await assertSharedTaskMedia('xdt-image://task/photo.png', capture);
    await expect(assertSharedTaskMedia('xdt-image://other/photo.png', capture)).rejects.toThrow();
  });
});
