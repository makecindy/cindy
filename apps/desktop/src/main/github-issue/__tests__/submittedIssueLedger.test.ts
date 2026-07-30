/**
 * 提交账本的持久化清洗:形状校验、同号去重留最新、倒序、上限。
 * 只测纯函数,不碰 electron-store(存储层只是 get/set 一个数组)。
 */

import { describe, expect, it } from 'vitest';

import type { SubmittedIssueRecord } from '../../../shared/myIssues';
import { normalizeSubmittedIssues } from '../submittedIssueLedger';

function record(over: Partial<SubmittedIssueRecord> = {}): SubmittedIssueRecord {
  return {
    number: 1001,
    url: 'https://github.com/makecindy/cindy/issues/1001',
    title: '标题',
    type: 'bug',
    submittedAt: '2026-07-01T00:00:00.000Z',
    identity: 'platform',
    publicName: 'shuji',
    ...over,
  };
}

describe('normalizeSubmittedIssues', () => {
  it('非数组或空输入返回空列表', () => {
    expect(normalizeSubmittedIssues(undefined)).toEqual([]);
    expect(normalizeSubmittedIssues(null)).toEqual([]);
    expect(normalizeSubmittedIssues({ issues: [] })).toEqual([]);
    expect(normalizeSubmittedIssues([])).toEqual([]);
  });

  it('丢掉形状不对的条目', () => {
    const kept = record();
    const dropped = [
      null,
      'nope',
      { ...record(), number: 0 },
      { ...record(), number: 1.5 },
      { ...record(), url: '' },
      { ...record(), type: 'question' },
      { ...record(), submittedAt: 'not-a-date' },
      { ...record(), identity: 'someone-else' },
      { ...record(), title: 42 },
    ];
    expect(normalizeSubmittedIssues([...dropped, kept])).toEqual([kept]);
  });

  it('按提交时间倒序', () => {
    const older = record({ number: 1, submittedAt: '2026-07-01T00:00:00.000Z' });
    const newer = record({ number: 2, submittedAt: '2026-07-20T00:00:00.000Z' });
    expect(normalizeSubmittedIssues([older, newer]).map((r) => r.number)).toEqual([2, 1]);
  });

  it('同一 issue 号只留提交时间最新的那条(与数组顺序无关)', () => {
    const old = record({ number: 7, title: '旧标题', submittedAt: '2026-07-01T00:00:00.000Z' });
    const fresh = record({ number: 7, title: '新标题', submittedAt: '2026-07-25T00:00:00.000Z' });
    for (const input of [[old, fresh], [fresh, old]]) {
      const result = normalizeSubmittedIssues(input);
      expect(result).toHaveLength(1);
      expect(result[0]!.title).toBe('新标题');
    }
  });

  it('总量压在 500 条内,保留最新的那些', () => {
    const many = Array.from({ length: 600 }, (_, index) =>
      record({
        number: index + 1,
        // index 越大时间越新
        submittedAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
      }),
    );
    const result = normalizeSubmittedIssues(many);
    expect(result).toHaveLength(500);
    expect(result[0]!.number).toBe(600);
    expect(result.at(-1)!.number).toBe(101);
  });

  it('github-user 记录保留 login,platform 记录保留公开署名', () => {
    const asUser = record({ number: 11, identity: 'github-user', githubLogin: 'octocat' });
    const asPlatform = record({ number: 12, identity: 'platform', publicName: '匿名' });
    const result = normalizeSubmittedIssues([asUser, asPlatform]);
    expect(result.find((r) => r.number === 11)?.githubLogin).toBe('octocat');
    expect(result.find((r) => r.number === 12)?.publicName).toBe('匿名');
  });
});
