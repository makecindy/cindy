import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: vi.fn(), ownerScopedUserDataPath: vi.fn() }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
import * as locks from '../crossProcessLock';
import { createRemoteModelAccessStore } from '../remoteModelAccess';
import { isRemoteModelSelection } from '../../../shared/remoteModelAccess';

/* 测试价值：用户要求本机与远程权限独立、按人限制。新生产存储的持久化、交集、空授权、损坏与切号
 * 原有供应商开关测试均未覆盖。最小输入：供应商的两个型号、两个成员；unit，临时目录可靠回收。耗时见执行报告。 */
let root: string;
let owner: string;
const filePath = () => path.join(root, owner, 'models.json');
const make = () => createRemoteModelAccessStore({ filePath, scopeKey: () => owner });
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-remote-models-')); owner = 'a'; });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe('remote model permissions', () => {
  it('keeps legacy access and future models open, distinguishes an empty grant, and restores inherited defaults', async () => {
    const store = make();
    expect(store.allows('p', 'future')).toBe(true);
    await store.set('p', [], undefined, () => {});
    expect(make().allows('p', 'future')).toBe(false);
    await store.set('p', null, undefined, () => {});
    expect(make().allows('p', 'future')).toBe(true);
  });
  it('intersects individual selections with the remote ceiling without changing other people or providers', async () => {
    const store = make();
    await store.set('p', ['small', 'large'], undefined, () => {});
    await store.set('p', ['small', 'future'], 'alice', () => {});
    await store.set('p', ['large'], 'bob', () => {});
    expect([store.allows('p', 'small', 'alice'), store.allows('p', 'large', 'alice'), store.allows('p', 'future', 'alice')]).toEqual([true, false, false]);
    expect(store.allows('p', 'large', 'bob')).toBe(true);
    expect(store.allows('p', 'large', 'new-person')).toBe(true);
    expect(store.allows('q', 'future', 'alice')).toBe(true);
    await store.set('p', ['small'], undefined, () => {});
    expect(store.allows('p', 'large', 'bob')).toBe(false);
    await store.set('p', null, 'alice', () => {});
    expect(make().read('p', 'alice').models).toBeNull();
  });
  it('isolates accounts and retains each account’s permissions after reopening', async () => {
    const store = make();
    await store.set('p', [], undefined, () => {});
    owner = 'b';
    expect(store.allows('p', 'large')).toBe(true);
    await store.set('p', ['large'], 'alice', () => {});
    owner = 'a';
    expect(store.allows('p', 'large')).toBe(false);
    owner = 'b';
    expect(make().allows('p', 'small', 'alice')).toBe(false);
  });
  it('merges concurrent scope changes instead of overwriting another person’s selection', async () => {
    await Promise.all([make().set('p', ['small'], 'alice', () => {}), make().set('p', ['large'], 'bob', () => {})]);
    expect(make().read('p', 'alice').models).toEqual(['small']);
    expect(make().read('p', 'bob').models).toEqual(['large']);
  });
  it('fails closed on damaged permissions and preserves the file for recovery', async () => {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), '{broken');
    const store = make();
    expect(store.allows('p', 'large')).toBe(false);
    await expect(store.set('p', ['large'], undefined, () => {})).rejects.toThrow();
    expect(fs.readFileSync(filePath(), 'utf8')).toBe('{broken');
    fs.writeFileSync(filePath(), JSON.stringify({ providers: { p: { models: 'invalid', members: {} } } }));
    expect(make().allows('p', 'large')).toBe(false);
  });
  it('rejects an account change while waiting for the write lock', async () => {
    vi.spyOn(locks, 'withCrossProcessLock').mockImplementationOnce(async (_file, _options, task) => { owner = 'b'; return task({ held: true }); });
    await expect(make().set('p', [], undefined, () => {})).rejects.toThrow();
    expect(fs.existsSync(filePath())).toBe(false);
  });
  it.each([{}, ['x', 'x'], [''], [' x'], [42], Array(4097).fill('m')])('refuses malformed model selections %#', (value) => {
    expect(isRemoteModelSelection(value)).toBe(false);
  });
});
