/**
 * 测试价值：C4 受管产物绑定合同；生产 readTeammateAvatarSource/prepareTeammateAvatarImage/storeTeammateAvatarImage。
 * 现有 selection 测试只测头部和图库，没有当前任务归属、真实解码、裁剪及内容哈希损坏分支。
 * 最小失败输入：另一任务的 blob 地址、正确 PNG 头部但无像素、换过内容的同一地址。tier: unit，真实临时文件/SQLite。
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import * as schema from '../../localDb/schema.js';
const state = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
import { readTeammateAvatarSource, createBotAvatarService } from '../botAvatarService.js';
import { writeBlob, resolveSafe } from '../../cindy-media/blobStore.js';
import { recordBlob, addRef } from '../../cindy-media/ledger.js';
import { storeTeammateAvatarImage } from '../../localDb/ipc/botAvatarSelection.js';
import { prepareTeammateAvatarImage } from '../../teammateAvatarImage.js';

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
beforeEach(() => {
  state.root = mkdtempSync(path.join(tmpdir(), 'designer-avatar-'));
  raw = new Database(':memory:');
  raw.exec(readFileSync(path.resolve(__dirname, '../../../../drizzle/0070_woozy_harpoon.sql'), 'utf8'));
  raw.exec('ALTER TABLE media_refs ADD COLUMN label TEXT');
  db = drizzle(raw, { schema });
});
afterEach(() => { raw.close(); rmSync(state.root, { recursive: true, force: true }); });
async function owned() {
  const buffer = await sharp({ create: { width: 400, height: 200, channels: 4, background: { r: 10, g: 30, b: 200, alpha: 0 } } }).png().toBuffer();
  const blob = await writeBlob({ buffer, mimeType: 'image/png' });
  await recordBlob({ ...blob, isCache: false }, db);
  await addRef({ hash: blob.hash, refKind: 'session-attachment', refId: 'designer' }, db);
  return { buffer, blob };
}
it('reads only task-owned managed bytes and detects altered content at the claimed address', async () => {
  const { buffer, blob } = await owned();
  expect(await readTeammateAvatarSource('designer', blob.url, db, () => {})).toEqual(buffer);
  await expect(readTeammateAvatarSource('other', blob.url, db, () => {})).rejects.toThrow('NOT_FOUND');
  await expect(readTeammateAvatarSource('designer', 'https://example.org/a.png', db, () => {})).rejects.toThrow('NOT_FOUND');
  writeFileSync(resolveSafe(blob.url).absPath, Buffer.from('changed'));
  await expect(readTeammateAvatarSource('designer', blob.url, db, () => {})).rejects.toThrow('INVALID_PARAMS');
});
it('decodes real pixels, preserves transparency and stores verified media bytes', async () => {
  const { buffer } = await owned();
  const image = await prepareTeammateAvatarImage(buffer, { crop: { left: 100, top: 0, width: 200, height: 200 } });
  expect(await sharp(image.buffer).metadata()).toMatchObject({ width: 256, height: 256, format: 'png', hasAlpha: true });
  const stored = await storeTeammateAvatarImage(image, db, () => {});
  expect(readFileSync(resolveSafe(stored.url).absPath)).toEqual(image.buffer);
  expect(raw.prepare('SELECT bytes, is_cache FROM media_blobs WHERE hash = ?').get(stored.hash)).toEqual({ bytes: image.buffer.length, is_cache: 0 });
  await expect(prepareTeammateAvatarImage(Buffer.from([137,80,78,71,13,10,26,10]))).rejects.toThrow('INVALID_PARAMS');
  await expect(prepareTeammateAvatarImage(buffer, { crop: { left: 0, top: 0, width: 1, height: 2 } })).rejects.toThrow('INVALID_PARAMS');
});
it('refreshes source admission after decode and does not bind after revocation', async () => {
  const { blob } = await owned();
  const setLocal = vi.fn();
  const service = createBotAvatarService({
    admit: async () => ({ assertCurrent() {}, refresh: async () => { throw new Error('revoked'); } }),
    readSource: (session, source, guard) => readTeammateAvatarSource(session, source, db, guard),
    setLocal,
  });
  await expect(service({ callerSessionId: 'designer', target: 'bot', imageSource: blob.url, expectedAvatar: '🤖', expectedVersion: 1 })).rejects.toThrow('revoked');
  expect(setLocal).not.toHaveBeenCalled();
});
