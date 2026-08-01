/**
 * Issue 响应解析:GitHub 原生形状与服务端可能用的 camelCase 形状都要吃,
 * 缺字段降级、坏条目过滤、外层三种容器形状、404 识别。
 */

import { describe, expect, it } from 'vitest';

import {
  isGithubNotFoundMessage,
  parseIssuePage,
  parseRemoteIssue,
} from '../githubIssuePayload';

const RAW_ISSUE = {
  number: 1061,
  title: 'skill(browser-translate): share the Skill',
  html_url: 'https://github.com/makecindy/cindy/issues/1061',
  state: 'open',
  labels: [{ id: 1, name: 'feature', color: 'ededed', description: '' }],
  created_at: '2026-07-30T09:12:49Z',
  updated_at: '2026-07-30T10:00:00Z',
  comments: 2,
};

const PARSED = {
  number: 1061,
  title: 'skill(browser-translate): share the Skill',
  htmlUrl: 'https://github.com/makecindy/cindy/issues/1061',
  state: 'open',
  labels: ['feature'],
  createdAt: '2026-07-30T09:12:49Z',
  updatedAt: '2026-07-30T10:00:00Z',
  commentCount: 2,
};

describe('parseRemoteIssue', () => {
  it('解析 GitHub 原生形状', () => {
    expect(parseRemoteIssue(RAW_ISSUE)).toEqual(PARSED);
  });

  it('同样吃服务端可能用的 camelCase 形状', () => {
    expect(
      parseRemoteIssue({
        number: 1061,
        title: PARSED.title,
        url: PARSED.htmlUrl,
        state: 'open',
        type: 'feature',
        createdAt: PARSED.createdAt,
        updatedAt: PARSED.updatedAt,
        commentCount: 2,
      }),
    ).toEqual(PARSED);
  });

  it('labels 为字符串数组时同样识别', () => {
    expect(parseRemoteIssue({ ...RAW_ISSUE, labels: ['bug', 42] })?.labels).toEqual(['bug']);
  });

  it('可选字段缺失时降级为 null,不整条丢弃', () => {
    expect(
      parseRemoteIssue({
        number: 7,
        title: 't',
        html_url: 'u',
        created_at: '2026-07-01T00:00:00Z',
      }),
    ).toMatchObject({ state: 'open', labels: [], updatedAt: null, commentCount: null });
  });

  it('state 非 closed 一律按 open', () => {
    expect(parseRemoteIssue({ ...RAW_ISSUE, state: 'closed' })?.state).toBe('closed');
    expect(parseRemoteIssue({ ...RAW_ISSUE, state: undefined })?.state).toBe('open');
  });

  it('关键字段缺失或类型不对时返回 null', () => {
    for (const bad of [
      null,
      'nope',
      [],
      { ...RAW_ISSUE, number: '1061' },
      { ...RAW_ISSUE, number: 1.5 },
      { ...RAW_ISSUE, title: null },
      { ...RAW_ISSUE, html_url: undefined, url: undefined },
      { ...RAW_ISSUE, created_at: 0 },
    ]) {
      expect(parseRemoteIssue(bad)).toBeNull();
    }
  });

  it('createdAt 必须可解析,不只是非空字符串', () => {
    // mergeIssues 的排序比较器直接 Date.parse 相减:不可解析会得到 NaN,让**整份**
    // 列表顺序变成未定义(不是这一条排错位置)。账本清洗早就这样校验 submittedAt。
    for (const bad of ['', 'not-a-date', '昨天', '2026-13-45T99:99:99Z']) {
      expect(parseRemoteIssue({ ...RAW_ISSUE, created_at: bad })).toBeNull();
    }
    // 合法的非 ISO 写法照常接受 —— 收紧的是「能不能解析」,不是「必须长成 ISO」。
    expect(parseRemoteIssue({ ...RAW_ISSUE, created_at: '2026-07-30' })?.createdAt).toBe(
      '2026-07-30',
    );
  });
});

describe('parseIssuePage', () => {
  it('接受 issues / items / 裸数组三种外层形状', () => {
    for (const payload of [{ issues: [RAW_ISSUE] }, { items: [RAW_ISSUE] }, [RAW_ISSUE]]) {
      expect(parseIssuePage(payload).issues).toEqual([PARSED]);
    }
  });

  it('坏条目被过滤,好条目保留', () => {
    const page = parseIssuePage({ issues: [RAW_ISSUE, { number: 'x' }, null] });
    expect(page.issues).toHaveLength(1);
  });

  it('总数字段认 total_count / totalCount / total', () => {
    expect(parseIssuePage({ total_count: 9, items: [RAW_ISSUE] }).totalCount).toBe(9);
    expect(parseIssuePage({ totalCount: 8, issues: [RAW_ISSUE] }).totalCount).toBe(8);
    expect(parseIssuePage({ total: 7, issues: [RAW_ISSUE] }).totalCount).toBe(7);
  });

  it('只给 hasMore 时也能表达「还有更多」', () => {
    expect(parseIssuePage({ hasMore: true, issues: [RAW_ISSUE] }).totalCount).toBe(2);
    expect(parseIssuePage({ hasMore: false, issues: [RAW_ISSUE] }).totalCount).toBeNull();
  });

  it('形状完全不对时返回空结果 + totalCount null', () => {
    expect(parseIssuePage(undefined)).toEqual({ issues: [], totalCount: null });
    expect(parseIssuePage({ items: 'nope' })).toEqual({ issues: [], totalCount: null });
  });
});

describe('isGithubNotFoundMessage', () => {
  it('识别两条通道的 404 文案', () => {
    expect(isGithubNotFoundMessage('GitHub API HTTP 404: Not Found')).toBe(true);
    expect(isGithubNotFoundMessage('not found')).toBe(true);
    expect(isGithubNotFoundMessage('HTTP 403: rate limit exceeded')).toBe(false);
  });
});
