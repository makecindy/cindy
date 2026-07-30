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

  it('平台接口未就绪:确有「状态未知」条目时才解释原因', () => {
    expect(
      selectMyIssuesNotices(
        result({ degraded: 'platform-unavailable', items: [item({ state: 'unknown' })] }),
      ),
    ).toEqual(['issueTracker.mine.platformUnavailableHint']);
  });

  it('平台接口未就绪 + 一条都没有:不提示 —— 用户没问,也没有可见损失', () => {
    expect(selectMyIssuesNotices(result({ degraded: 'platform-unavailable' }))).toEqual([]);
  });

  it('平台接口未就绪但列表全部有真实状态(纯 GitHub 增强来源):不提示', () => {
    // 判据若写成 items.length > 0,这里会错误地说「只显示本机记录」——文案也不成立。
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
    ).toEqual([]);
  });

  it('混合列表里只要有一条状态未知就提示', () => {
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
    ).toEqual(['issueTracker.mine.platformUnavailableHint']);
  });

  it('未登录 / 取数失败无条件提示,空列表时也要说清是「没查到」而不是「没有」', () => {
    expect(selectMyIssuesNotices(result({ degraded: 'not-signed-in' }))).toEqual([
      'issueTracker.mine.notSignedInHint',
    ]);
    expect(selectMyIssuesNotices(result({ degraded: 'fetch-failed' }))).toEqual([
      'issueTracker.mine.fetchFailedHint',
    ]);
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
