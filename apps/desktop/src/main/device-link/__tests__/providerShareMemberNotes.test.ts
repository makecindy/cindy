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
import { createProviderShareMemberNotesStore } from '../providerShareMemberNotes';

/*
 * 测试价值
 * - 生产入口与可观察结果：备注存储的 set/read；重启可读、清空恢复默认、不同成员与账号互不覆盖。
 * - Bug／规则依据：2026-10-19 用户要求分享用户备注；credentials-and-local-storage 的账号隔离与原子写规则。
 * - 现有覆盖缺口：新备注文件有独立 schema 与生命周期，现有分享授权偏好测试不覆盖此存储。
 * - 最小失败输入：同一成员在两个账号保存不同备注；锁等待期间切账号；损坏的备注文件。
 * - tier：unit；唯一临时目录，无账号、网络或子进程。独立文件隔离该存储的真实文件生命周期。
 * - 实测耗时：单独 vitest run 本文件 1.38 秒（4 用例执行 464ms）。
 */
let root: string;
let owner: string;
const file = () => path.join(root, owner, 'provider-share-member-notes.json');
const makeStore = () =>
  createProviderShareMemberNotesStore({ filePath: file, scopeKey: () => owner });
const assertCurrent = () => undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-member-notes-'));
  owner = 'owner-a';
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('provider share member notes', () => {
  it('persists notes across store recreation, preserves other members and removes cleared overrides', async () => {
    const first = makeStore();
    const second = makeStore();
    expect(second.read()).toEqual({});
    await first.set('m1', 'Alice', assertCurrent);
    await second.set('m2', 'Bob', assertCurrent);
    expect(makeStore().read()).toEqual({ m1: 'Alice', m2: 'Bob' });
    await first.set('m1', '', assertCurrent);
    expect(makeStore().read()).toEqual({ m2: 'Bob' });
  });

  it('isolates the same member id by account, including a cached store', async () => {
    const store = makeStore();
    await store.set('m1', 'Alice', assertCurrent);
    owner = 'owner-b';
    expect(store.read()).toEqual({});
    await store.set('m1', 'Bob', assertCurrent);
    owner = 'owner-a';
    expect(store.read()).toEqual({ m1: 'Alice' });
  });

  it('refuses a write that crosses accounts while waiting for the file lock', async () => {
    const store = makeStore();
    await store.set('m1', 'Alice', assertCurrent);
    const originalFile = file();
    vi.spyOn(locks, 'withCrossProcessLock').mockImplementationOnce(
      async (_file, _options, task) => {
        owner = 'owner-b';
        return task({ held: true });
      },
    );
    await expect(store.set('m1', 'wrong account', assertCurrent)).rejects.toThrow(
      'PRECONDITION_FAILED',
    );
    expect(fs.existsSync(file())).toBe(false);
    expect(JSON.parse(fs.readFileSync(originalFile, 'utf8')).notes.m1).toBe('Alice');
  });

  it('keeps an unreadable file intact and reports a save failure without exposing its contents', async () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), '{private broken content');
    const store = makeStore();
    expect(store.read()).toEqual({});
    await expect(store.set('m1', 'Alice', assertCurrent)).rejects.toThrow(
      '[PRECONDITION_FAILED] Could not save provider share member note',
    );
    expect(fs.readFileSync(file(), 'utf8')).toBe('{private broken content');
  });
});
