/**
 * 首屏快照的账号隔离回归。
 *
 * 快照里有 issue 标题与 GitHub 用户名 —— 是账号私有数据,不是可共享的缓存。存储走
 * ownerScopedUserDataPath(),换号后必须读不到上一个账号的快照(否则切号瞬间的首屏会
 * 闪出别人的 issue 列表)。
 *
 * 这里钉住「store 实例跟着 owner 路径重建」这一条 —— electron-store 被 mock,不碰真实
 * 文件系统(mock 形状照 submittedIssueLedgerScope.test.ts)。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MyIssuesSnapshot } from '../../../shared/myIssues';

const ownerPathRef = { value: '/tmp/cindy-test-owner-a' };
/** 按 owner 路径分桶,模拟真实的「每个账号一个目录」。 */
const buckets: Record<string, Record<string, unknown>> = {};

vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: () => ownerPathRef.value,
}));

vi.mock('electron-store', () => ({
  default: class FakeStore {
    private readonly bucket: Record<string, unknown>;
    constructor(options: { cwd: string }) {
      buckets[options.cwd] ??= {};
      this.bucket = buckets[options.cwd]!;
    }
    get(key: string, fallback: unknown) {
      return this.bucket[key] ?? fallback;
    }
    set(key: string, value: unknown) {
      this.bucket[key] = value;
    }
  },
}));

const { readMyIssuesSnapshot, writeMyIssuesSnapshot } = await import('../myIssuesSnapshotStore');

function snapshot(over: Partial<MyIssuesSnapshot> = {}): MyIssuesSnapshot {
  return {
    items: [
      {
        number: 1061,
        url: 'https://github.com/makecindy/cindy/issues/1061',
        title: '账号 A 的 issue 标题',
        type: 'bug',
        state: 'open',
        createdAt: '2026-07-30T09:12:49.000Z',
        updatedAt: null,
        commentCount: null,
        sources: ['cindy-tool'],
      },
    ],
    githubEnhancement: { login: 'owner-a-login', source: 'ghost' },
    cachedAt: '2026-07-31T12:00:00.000Z',
    ...over,
  };
}

/**
 * 每个用例用一组**全新路径**。store 实例按 owner 路径缓存在模块级变量里,清空 buckets
 * 并不会让它重建 —— 复用旧实例会读到一个已被移除的桶对象,用例之间互相污染。
 */
let caseId = 0;
const ownerPath = (owner: 'a' | 'b') => `/tmp/cindy-test-${caseId}-owner-${owner}`;

beforeEach(() => {
  for (const key of Object.keys(buckets)) delete buckets[key];
  caseId += 1;
  ownerPathRef.value = ownerPath('a');
});

describe('首屏快照的账号隔离', () => {
  it('同一账号内写了能读回来', () => {
    writeMyIssuesSnapshot(snapshot());
    expect(readMyIssuesSnapshot()?.items.map((i) => i.number)).toEqual([1061]);
    expect(readMyIssuesSnapshot()?.githubEnhancement?.login).toBe('owner-a-login');
  });

  it('切到另一个账号后读不到上一个账号的快照', () => {
    writeMyIssuesSnapshot(snapshot());
    expect(readMyIssuesSnapshot()).not.toBeNull();

    ownerPathRef.value = ownerPath('b');
    // 账号 B 的首屏必须是干净的 —— 既不能看到 A 的标题,也不能看到 A 的 GitHub 用户名。
    expect(readMyIssuesSnapshot()).toBeNull();
  });

  it('切回原账号仍能读到自己那份', () => {
    writeMyIssuesSnapshot(snapshot());
    ownerPathRef.value = ownerPath('b');
    writeMyIssuesSnapshot(snapshot({ githubEnhancement: { login: 'owner-b-login', source: 'gh-cli' } }));

    ownerPathRef.value = ownerPath('a');
    expect(readMyIssuesSnapshot()?.githubEnhancement?.login).toBe('owner-a-login');
  });

  it('账号 B 写入不会污染账号 A 的桶', () => {
    writeMyIssuesSnapshot(snapshot());
    ownerPathRef.value = ownerPath('b');
    writeMyIssuesSnapshot(snapshot({ items: [] }));

    ownerPathRef.value = ownerPath('a');
    expect(readMyIssuesSnapshot()?.items).toHaveLength(1);
  });
});
