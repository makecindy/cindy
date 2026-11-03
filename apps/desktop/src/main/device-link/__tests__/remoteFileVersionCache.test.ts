import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({ root: '', owner: 'a', generation: 0 }));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
vi.mock('../../appSessionState', () => ({
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: state.owner }),
}));
vi.mock('../broadcast-tap', () => ({
  captureDataOwnerBroadcastScope: () => ({ owner: state.owner, generation: state.generation }),
  isDataOwnerBroadcastScopeCurrent: (scope: typeof state) =>
    scope.owner === state.owner && scope.generation === state.generation,
}));
import { remoteFileVersionCache } from '../remoteFileVersionCache';

beforeEach(async () => {
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-version-cache-'));
  state.owner = 'a';
  state.generation = 0;
});
afterEach(async () => {
  await fs.rm(state.root, { recursive: true, force: true });
});
const metadata = { version: 'a'.repeat(64), size: 5, mimeType: 'text/html' };
it('retains a complete fallback download for a later version-validated read', async () => {
  await remoteFileVersionCache('device', 'url', metadata)!.put(Buffer.from('hello'));
  state.generation++;
  const file = await remoteFileVersionCache('device', 'url', metadata)!.get();
  expect(await fs.readFile(file!, 'utf8')).toBe('hello');
  expect(await remoteFileVersionCache('device', 'url', { ...metadata, version: 'b'.repeat(64) })!.get()).toBeNull();
});
it('keeps large files across new cache instances and login generations, with independent owner/device/url identities', async () => {
  const file = path.join(state.root, 'original');
  const size = 17 * 1024 * 1024;
  await fs.writeFile(file, Buffer.alloc(size, 42));
  const meta = { ...metadata, size };
  const first = remoteFileVersionCache('device', 'url?baseDir=/allowed', meta)!;
  await first.put(file);
  await fs.rm(file);
  state.generation++;
  await expect(first.get()).rejects.toThrow('FILE_PEER_CANCELLED');
  const restarted = remoteFileVersionCache('device', 'url?baseDir=/allowed', meta)!;
  const hit = await restarted.get();
  expect((await fs.stat(hit!)).size).toBe(size);
  expect(
    await remoteFileVersionCache('other-device', 'url?baseDir=/allowed', meta)!.get(),
  ).toBeNull();
  expect(await remoteFileVersionCache('device', 'url?baseDir=/other', meta)!.get()).toBeNull();
  state.owner = 'b';
  expect(await remoteFileVersionCache('device', 'url?baseDir=/allowed', meta)!.get()).toBeNull();
  state.owner = 'a';
  expect(await remoteFileVersionCache('device', 'url?baseDir=/allowed', meta)!.get()).toBe(hit);
});
it('removes superseded versions but preserves consumer copies, and treats missing or truncated files as misses', async () => {
  const file = path.join(state.root, 'source');
  await fs.writeFile(file, 'hello');
  const old = remoteFileVersionCache('device', 'url', metadata)!;
  await old.put(file);
  const oldPath = (await old.get())!;
  const consumer = path.join(state.root, 'consumer');
  await fs.copyFile(oldPath, consumer);
  const changed = remoteFileVersionCache('device', 'url', {
    ...metadata,
    version: 'b'.repeat(64),
  })!;
  expect(await changed.get()).toBeNull();
  await fs.writeFile(file, 'world');
  await changed.put(file);
  expect(await old.get()).toBeNull();
  expect(await fs.readFile(consumer, 'utf8')).toBe('hello');
  const hit = (await changed.get())!;
  expect(await fs.readFile(hit, 'utf8')).toBe('world');
  await fs.truncate(hit, 1);
  expect(await changed.get()).toBeNull();
  await fs.rm(hit);
  expect(await changed.get()).toBeNull();
});
it('does not enable persistent reuse without a valid host version', () => {
  expect(remoteFileVersionCache('device', 'url')).toBeNull();
  expect(remoteFileVersionCache('device', 'url', { ...metadata, version: '../file' })).toBeNull();
});
