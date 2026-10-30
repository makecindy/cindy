import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cindy/mcps', async () => import('../../../../../../packages/lizi-mcps/src/session-path-auth.js'));
vi.mock('../../cindy-brain/dirDeposit.js', () => ({ isPathInsideDir: (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
} }));
vi.mock('../blobStore.js', () => ({ mimeForExt: (ext: string) => ext === '.png' ? 'image/png' : null }));
const ingest = vi.hoisted(() => vi.fn());
const hasRef = vi.hoisted(() => vi.fn());
const owner = vi.hoisted(() => ({ dataOwnerId: 'owner', generation: 1 }));
vi.mock('../ingest.js', () => ({ ingestMedia: ingest }));
vi.mock('../ledger.js', () => ({ hasRef }));
vi.mock('../refCompensationJournal.js', () => ({ captureMediaRefCompensationScope: () => ({}) }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: 'captured-db' }) }));
vi.mock('../../appSessionState.js', () => ({ getActiveAppSession: () => ({ ...owner }), isAppSessionBoundaryPending: () => false }));
import { publishImage } from '../publishImage.js';

let root: string;
let workdir: string;
const url = `cindy-media://blobs/${'a'.repeat(64)}.png`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-publish-image-'));
  workdir = path.join(root, 'work');
  await fs.mkdir(workdir);
  ingest.mockReset().mockResolvedValue({ url, hash: 'a'.repeat(64), ext: '.png' });
  hasRef.mockReset().mockResolvedValue(false);
  owner.generation = 1;
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('publishImage', () => {
  it('pins only once when the same task imports identical bytes concurrently', async () => {
    await fs.writeFile(path.join(workdir, 'shot.png'), png);
    let pinned = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    hasRef.mockImplementation(async () => pinned);
    ingest.mockImplementation(async (params) => {
      await gate;
      if (params.refs.length) pinned = true;
      return { url, hash: 'a'.repeat(64), ext: '.png' };
    });
    const imports = Array.from({ length: 8 }, () => publishImage('shot.png',
      { workingDir: workdir, sessionId: 'task' }, { isCurrent: () => true, authorize: vi.fn() }));
    try {
      await vi.waitFor(() => expect(ingest).toHaveBeenCalledOnce());
      expect(hasRef).toHaveBeenCalledOnce();
    } finally { release(); }
    expect((await Promise.all(imports)).every((result) => result.ok)).toBe(true);
    expect(ingest.mock.calls.flatMap(([params]) => params.refs)).toHaveLength(1);
  });

  it('releases the reference lock after failure so a queued retry can pin', async () => {
    await fs.writeFile(path.join(workdir, 'shot.png'), png);
    ingest.mockRejectedValueOnce(new Error('failed'));
    const results = await Promise.all(Array.from({ length: 2 }, () => publishImage('shot.png',
      { workingDir: workdir, sessionId: 'task' }, { isCurrent: () => true, authorize: vi.fn() })));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => result.errorCode === 'MEDIA_PUBLISH_FAILED')).toHaveLength(1);
    expect(ingest.mock.calls[1][0].refs).toHaveLength(1);
  });

  it('does not share a pinned reference between tasks', async () => {
    await fs.writeFile(path.join(workdir, 'shot.png'), png);
    const results = await Promise.all(['first', 'second'].map((sessionId) => publishImage('shot.png',
      { workingDir: workdir, sessionId }, { isCurrent: () => true, authorize: vi.fn() })));
    expect(results.every((result) => result.ok)).toBe(true);
    expect(ingest.mock.calls.flatMap(([params]) => params.refs.map((ref: { refId: string }) => ref.refId)).sort()).toEqual(['first', 'second']);
  });

  it('reads the actual file and pins the returned Host URL before reporting success', async () => {
    const bytes = png;
    await fs.writeFile(path.join(workdir, 'shot.png'), bytes);
    const authorize = vi.fn();
    const result = await publishImage('shot.png', { workingDir: workdir, sessionId: 'task' }, { isCurrent: () => true, authorize });
    expect(result).toMatchObject({ ok: true, xdt_image_urls: [url] });
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ buffer: bytes, mimeType: 'image/png',
      refs: [{ refKind: 'session-attachment', refId: 'task', originSessionId: 'task', originKind: 'tool' }],
      assertStillValid: expect.any(Function), refCompensationScope: expect.any(Object),
    }), 'captured-db');
    expect(authorize).not.toHaveBeenCalled();
  });

  it('does not read outside-workdir images without the existing path grant', async () => {
    const file = path.join(root, 'outside.png');
    await fs.writeFile(file, 'outside');
    const authorize = vi.fn(async () => ({ allowed: false as const, reason: 'denied' }));
    expect(await publishImage(file, { workingDir: workdir, sessionId: 'task' }, { isCurrent: () => true, authorize })).toMatchObject({ errorCode: 'PERMISSION_DENIED' });
    expect(authorize).toHaveBeenCalledWith(await fs.realpath(file));
    expect(ingest).not.toHaveBeenCalled();
  });

  it('rejects missing files, stale task instances and SSH local-name fallback', async () => {
    const context = { workingDir: workdir, sessionId: 'task' };
    const deps = { isCurrent: () => true, authorize: vi.fn() };
    expect(await publishImage('missing.png', context, deps)).toMatchObject({ errorCode: 'MEDIA_SOURCE_MISSING' });
    expect(await publishImage('missing.png', context, { ...deps, isCurrent: () => false })).toMatchObject({ errorCode: 'PERMISSION_DENIED' });
    expect(await publishImage('missing.png', { ...context, remoteHostId: 'ssh' }, deps)).toMatchObject({ errorCode: 'REMOTE_SOURCE_REQUIRED' });
    expect(ingest).not.toHaveBeenCalled();
  });

  it('does not hand out a URL if reference registration fails', async () => {
    await fs.writeFile(path.join(workdir, 'shot.png'), png);
    ingest.mockRejectedValueOnce(new Error('ref registration failed'));
    const result = await publishImage('shot.png', { workingDir: workdir, sessionId: 'task' }, { isCurrent: () => true, authorize: vi.fn() });
    expect(result).toMatchObject({ ok: false, errorCode: 'MEDIA_PUBLISH_FAILED' });
    expect(result).not.toHaveProperty('url');
  });

  it('reuses an existing task reference and guards every ingest await against account switches', async () => {
    await fs.writeFile(path.join(workdir, 'shot.png'), png);
    hasRef.mockResolvedValueOnce(true);
    await publishImage('shot.png', { workingDir: workdir, sessionId: 'task' }, { isCurrent: () => true, authorize: vi.fn() });
    expect(ingest.mock.calls[0][0].refs).toEqual([]);
    const assertCurrent = ingest.mock.calls[0][0].assertStillValid;
    expect(assertCurrent).not.toThrow();
    owner.generation++;
    expect(assertCurrent).toThrow('scope changed');
  });

  it('rejects text disguised as a PNG before ingesting', async () => {
    await fs.writeFile(path.join(workdir, 'shot.png'), 'not an image');
    const result = await publishImage('shot.png', { workingDir: workdir, sessionId: 'task' }, { isCurrent: () => true, authorize: vi.fn() });
    expect(result).toMatchObject({ errorCode: 'INVALID_IMAGE' });
    expect(ingest).not.toHaveBeenCalled();
  });

  it('rechecks grants after outside-workdir approval', async () => {
    const file = path.join(root, 'outside.png');
    await fs.writeFile(file, 'outside');
    const authorize = vi.fn(async () => ({ allowed: true as const, isCurrent: () => false }));
    expect(await publishImage(file, { workingDir: workdir, sessionId: 'task' }, { isCurrent: () => true, authorize })).toMatchObject({ errorCode: 'PERMISSION_DENIED' });
    expect(ingest).not.toHaveBeenCalled();
  });
});
