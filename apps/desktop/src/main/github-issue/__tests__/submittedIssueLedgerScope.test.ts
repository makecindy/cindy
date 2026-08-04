/**
 * 账本写入的账号归属回归。
 *
 * 提交要等用户确认 + 一次网络往返,期间可能切号;而 getStore() 走
 * ownerScopedUserDataPath() 读的是**落地时**的账号路径。不带发起时的作用域校验,
 * 账号 A 的提交就会写进账号 B 的账本并出现在 B 的「我的 Issue」里。
 *
 * 这里只测「作用域不匹配就放弃写入」这一条判据 —— electron-store 与 electron 都被
 * mock 掉,不碰真实文件系统。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SubmittedIssueRecord } from '../../../shared/myIssues';

const scopeRef = { value: 'owner-a:1' };
const stored: Record<string, unknown> = {};

vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => scopeRef.value,
  ownerScopedUserDataPath: () => '/tmp/cindy-test-owner',
}));

vi.mock('electron-store', () => ({
  default: class FakeStore {
    get(key: string, fallback: unknown) {
      return stored[key] ?? fallback;
    }
    set(key: string, value: unknown) {
      stored[key] = value;
    }
  },
}));

const { listSubmittedIssues, recordSubmittedIssue } = await import('../submittedIssueLedger');

/** url 跟着 number 走 —— 清洗要求两者指向同一条 issue(见 isMyIssueUrl)。 */
function record(over: Partial<SubmittedIssueRecord> = {}): SubmittedIssueRecord {
  const number = over.number ?? 1061;
  return {
    number,
    url: `https://github.com/makecindy/cindy/issues/${number}`,
    title: '账号 A 提交的 issue',
    type: 'feature',
    submittedAt: '2026-07-30T09:12:49.000Z',
    identity: 'platform',
    publicName: 'shuji',
    ...over,
  };
}

beforeEach(() => {
  for (const key of Object.keys(stored)) delete stored[key];
  scopeRef.value = 'owner-a:1';
});

describe('recordSubmittedIssue 的账号归属校验', () => {
  it('作用域一致时正常写入', () => {
    const next = recordSubmittedIssue(record(), 'owner-a:1');
    expect(next.map((r) => r.number)).toEqual([1061]);
    expect(listSubmittedIssues().map((r) => r.number)).toEqual([1061]);
  });

  it('提交期间切了账号 → 放弃写入,不把 A 的提交记进 B 的账本', () => {
    scopeRef.value = 'owner-b:2'; // 落地时已经是另一个账号
    const next = recordSubmittedIssue(record(), 'owner-a:1');
    expect(next).toEqual([]);
    expect(listSubmittedIssues()).toEqual([]);
  });

  it('同一 owner 但 generation 变了(登出再登回)同样放弃写入', () => {
    scopeRef.value = 'owner-a:3';
    recordSubmittedIssue(record(), 'owner-a:1');
    expect(listSubmittedIssues()).toEqual([]);
  });

  it('放弃写入时不破坏已有账本内容', () => {
    recordSubmittedIssue(record({ number: 1 }), 'owner-a:1');
    scopeRef.value = 'owner-b:2';
    const next = recordSubmittedIssue(record({ number: 2 }), 'owner-a:1');
    // 返回的是当前账号视角下的既有列表,且没有把 #2 混进去。
    expect(next.map((r) => r.number)).toEqual([1]);
    expect(listSubmittedIssues().map((r) => r.number)).toEqual([1]);
  });
});
