/**
 * 提交账本的持久化清洗:形状校验、同号去重留最新、倒序、上限。
 * 只测纯函数,不碰 electron-store(存储层只是 get/set 一个数组)。
 */

import { describe, expect, it } from 'vitest';

import type { SubmittedIssueRecord } from '../../../shared/myIssues';
import { normalizeSubmittedIssues } from '../submittedIssueLedger';

/**
 * url 默认跟着 number 走 —— 校验要求两者一致(显示 #N 就必须点开 #N),
 * fixture 里各写一份必然对不上。要测不一致的场景就显式覆盖 url。
 */
function record(over: Partial<SubmittedIssueRecord> = {}): SubmittedIssueRecord {
  const number = over.number ?? 1001;
  return {
    number,
    url: `https://github.com/makecindy/cindy/issues/${number}`,
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

  it('丢掉链接不指向本仓这一号 issue 的条目', () => {
    // 落盘文件是不可信输入,而这一页每行都声称「你在本仓提的 issue」、整行可点开。
    // 只查「非空字符串」的写法会把下面每一条都放行。
    const dropped = [
      { ...record(), url: 'https://evil.example.com/makecindy/cindy/issues/1001' },
      { ...record(), url: 'https://github.com.evil.example/makecindy/cindy/issues/1001' },
      { ...record(), url: 'http://github.com/makecindy/cindy/issues/1001' },
      { ...record(), url: 'https://github.com/someone/else/issues/1001' },
      // 编号对不上:显示 #1001 却点开另一条 issue
      { ...record(), url: 'https://github.com/makecindy/cindy/issues/9999' },
      { ...record(), url: 'https://github.com/makecindy/cindy/pull/1001' },
      { ...record(), url: 'javascript:alert(1)' },
      { ...record(), url: 'not-a-url' },
    ];
    expect(normalizeSubmittedIssues(dropped)).toEqual([]);
  });

  it('容忍尾斜杠 —— 不误杀用户真实的历史记录', () => {
    const withSlash = record({ url: 'https://github.com/makecindy/cindy/issues/1001/' });
    expect(normalizeSubmittedIssues([withSlash])).toEqual([withSlash]);
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
