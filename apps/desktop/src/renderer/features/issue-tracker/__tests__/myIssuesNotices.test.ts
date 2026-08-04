/**
 * 顶部提示的选取规则 —— 钉住「哪些降级值得打扰用户」这个产品判断。
 */

import { describe, expect, it } from 'vitest';

import type { MyIssueItem, MyIssuesResult } from '@/../shared/myIssues';

import { selectMyIssuesNotices } from '../lib/myIssuesNotices';

function item(over: Partial<MyIssueItem> = {}): MyIssueItem {
  return {
    number: 1,
    url: 'https://github.com/makecindy/cindy/issues/1',
    title: 't',
    type: 'bug',
    state: 'unknown',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: null,
    commentCount: null,
    sources: ['cindy-tool'],
    ...over,
  };
}

function result(over: Partial<MyIssuesResult> = {}): MyIssuesResult {
  return {
    items: [],
    githubEnhancement: null,
    degraded: null,
    truncated: false,
    ...over,
  };
}

describe('selectMyIssuesNotices', () => {
  it('一切正常时不打扰用户', () => {
    expect(selectMyIssuesNotices(result({ items: [item()] }))).toEqual([]);
  });

  it('平台接口未就绪 + 列表只有本机账本:说「只显示本机记录」成立', () => {
    expect(
      selectMyIssuesNotices(
        result({ degraded: 'platform-unavailable', items: [item({ state: 'unknown' })] }),
      ),
    ).toEqual(['issueTracker.mine.platformUnavailableHint']);
  });

  it('平台接口未就绪 + 一条都没有:**必须**提示 —— 空的本机兜底不能证明远端历史为空', () => {
    // 曾经这里返回 [](想省掉接口上线前的常驻横幅),但那会让新设备 / 重装 / 提交早于
    // 账本功能的用户直接看到「还没有提交过 Issue」,把「暂时查不到」说成「你从未提交」。
    expect(selectMyIssuesNotices(result({ degraded: 'platform-unavailable' }))).toEqual([
      'issueTracker.mine.platformUnavailableHint',
    ]);
  });

  it('平台接口未就绪但列表全部来自远端:提示历史可能不全,但不说「只显示本机记录」', () => {
    expect(
      selectMyIssuesNotices(
        result({
          degraded: 'platform-unavailable',
          items: [
            item({ number: 1, state: 'open', sources: ['github-account'] }),
            item({ number: 2, state: 'closed', sources: ['github-account'] }),
          ],
        }),
      ),
    ).toEqual(['issueTracker.mine.platformUnavailablePartialHint']);
  });

  it('混合列表(增强有内容 + 账本里一条平台代发):不得谎称「只显示本机记录」', () => {
    // 这正是读接口未上线时最常见的真实场景:平台 404、GitHub 增强并回几十条、账本里
    // 有一条平台代发记录(作者是 cindy-issue App,不出现在 author: 搜索里 → 保持
    // unknown)。旧判据 some(state === 'unknown') 在这里为真,于是推出「只显示本机
    // 记录」——而同一页明明列着一堆 GitHub 账号名下的 issue。
    expect(
      selectMyIssuesNotices(
        result({
          degraded: 'platform-unavailable',
          items: [
            item({ number: 1, state: 'open', sources: ['github-account'] }),
            item({ number: 2, state: 'unknown', sources: ['cindy-tool'] }),
          ],
        }),
      ),
    ).toEqual(['issueTracker.mine.platformUnavailablePartialHint']);
  });

  it('未登录 / 取数失败无条件提示,空列表时也要说清是「没查到」而不是「没有」', () => {
    expect(selectMyIssuesNotices(result({ degraded: 'not-signed-in' }))).toEqual([
      'issueTracker.mine.notSignedInHint',
    ]);
    expect(selectMyIssuesNotices(result({ degraded: 'fetch-failed' }))).toEqual([
      'issueTracker.mine.fetchFailedHint',
    ]);
  });

  it('取数失败但增强带回了远端条目:不说「只显示本机记录」(否则与同页列出的自相矛盾)', () => {
    const withRemote = result({
      degraded: 'fetch-failed',
      items: [item({ state: 'open' }), item({ number: 2 })],
    });
    expect(selectMyIssuesNotices(withRemote)).toEqual([
      'issueTracker.mine.fetchFailedPartialHint',
    ]);

    // 全部条目都没有实时状态 → 列表确实只有本机账本,那句结论成立。
    const ledgerOnly = result({ degraded: 'fetch-failed', items: [item(), item({ number: 2 })] });
    expect(selectMyIssuesNotices(ledgerOnly)).toEqual(['issueTracker.mine.fetchFailedHint']);
  });

  it('判据看 state 而不是 sources —— 账本里 github-user 的记录也打 github-account', () => {
    // 上一轮起,账本 identity=github-user 的条目会带 github-account 来源(提交时确认的
    // 事实),所以 sources 不再等价于「来自远端」。用它当判据会误报成 partial。
    const ledgerGithubUser = result({
      degraded: 'fetch-failed',
      items: [item({ sources: ['cindy-tool', 'github-account'], state: 'unknown' })],
    });
    expect(selectMyIssuesNotices(ledgerGithubUser)).toEqual(['issueTracker.mine.fetchFailedHint']);
  });

  it('截断与降级可以同时提示', () => {
    expect(
      selectMyIssuesNotices(result({ degraded: 'fetch-failed', truncated: true, items: [item()] })),
    ).toEqual(['issueTracker.mine.fetchFailedHint', 'issueTracker.mine.truncatedHint']);
  });

  it('提示文案 key 与 UI 用的一致(没有 GitHub 身份时绝不提示连接 GitHub)', () => {
    const keys = [
      ...selectMyIssuesNotices(result({ degraded: 'platform-unavailable', items: [item()] })),
      ...selectMyIssuesNotices(result({ degraded: 'not-signed-in' })),
      ...selectMyIssuesNotices(result({ degraded: 'fetch-failed' })),
      ...selectMyIssuesNotices(result({ truncated: true })),
    ];
    expect(keys.some((key) => /viewerNone|noToken|connectGithub/i.test(key))).toBe(false);
  });
});
