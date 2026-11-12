import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: vi.fn(),
  ownerScopedUserDataPath: vi.fn(),
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
import * as locks from '../crossProcessLock';
import { createProviderShareVisibilityStore } from '../providerShareVisibility';
/* 测试价值：新权限文件默认关闭、独立保存、重启与账号隔离、损坏不覆盖；旧备注测试没有此schema。
 * 最小输入：两个供应商及两个账号、锁等待切号、无效JSON。unit；独立临时目录并清理。耗时见执行报告。 */
let root: string;
let owner: string;
const file = () => path.join(root, owner, 'visibility.json');
const make = () => createProviderShareVisibilityStore({ filePath: file, scopeKey: () => owner });
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-share-visibility-'));
  owner = 'a';
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
describe('share visibility persistence', () => {
  it('defaults off, independently updates both permissions and preserves other providers across restarts', async () => {
    const store = make();
    expect(store.read('p')).toEqual({ quota: false, usage: false, revision: 0 });
    await store.set('p', { quota: true }, () => {});
    await store.set('q', { usage: true }, () => {});
    await store.set('p', { usage: true }, () => {});
    await store.set('p', { quota: false }, () => {});
    expect(make().read('p')).toEqual({ quota: false, usage: true, revision: 3 });
    expect(make().read('q')).toEqual({ quota: false, usage: true, revision: 1 });
  });
  it('isolates matching provider ids and cache across owners', async () => {
    const store = make();
    await store.set('p', { quota: true }, () => {});
    owner = 'b';
    expect(store.read('p').quota).toBe(false);
    await store.set('p', { usage: true }, () => {});
    owner = 'a';
    expect(store.read('p')).toMatchObject({ quota: true, usage: false });
  });
  it('refuses writes crossing an owner boundary while waiting for a lock', async () => {
    vi.spyOn(locks, 'withCrossProcessLock').mockImplementationOnce(
      async (_file, _options, task) => {
        owner = 'b';
        return task({ held: true });
      },
    );
    await expect(make().set('p', { quota: true }, () => {})).rejects.toThrow();
    expect(fs.existsSync(file())).toBe(false);
  });
  it('keeps unreadable permission files intact and defaults to no access', async () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), '{broken');
    const store = make();
    expect(store.read('p')).toMatchObject({ quota: false, usage: false });
    await expect(store.set('p', { quota: true }, () => {})).rejects.toThrow();
    expect(fs.readFileSync(file(), 'utf8')).toBe('{broken');
  });
});
