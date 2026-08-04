// @vitest-environment jsdom

/**
 * MyIssueList —— 行内元信息拼装、来源标记、状态点形态、点击外链。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MyIssueItem } from '@/../shared/myIssues';

import { MyIssueList } from '../MyIssueList';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // 元信息断言直接看 key,避免绑死具体译文。
    t: (key: string, vars?: Record<string, unknown>) =>
      vars && 'count' in vars ? `${key}:${String(vars.count)}` : key,
    i18n: { language: 'zh-CN' },
  }),
}));

function item(over: Partial<MyIssueItem> = {}): MyIssueItem {
  return {
    number: 1061,
    url: 'https://github.com/makecindy/cindy/issues/1061',
    title: '内置浏览器翻译按钮',
    type: 'feature',
    state: 'open',
    createdAt: '2026-07-30T09:12:49Z',
    updatedAt: '2026-07-30T10:00:00Z',
    commentCount: 2,
    sources: ['github-account'],
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MyIssueList', () => {
  it('渲染标题与元信息(编号 / 状态 / 类型 / 来源 / 评论数)', () => {
    render(<MyIssueList items={[item()]} />);
    expect(screen.getByText('内置浏览器翻译按钮')).toBeTruthy();
    const meta = screen.getByText(/#1061/).textContent!;
    expect(meta).toContain('issueTracker.status.open');
    expect(meta).toContain('issueTracker.type.feature');
    expect(meta).toContain('issueTracker.mine.sourceGithub');
    expect(meta).toContain('issueTracker.mine.commentCount:2');
  });

  it('平台代发(只在账本里)标 sourceCindy 且状态标未知', () => {
    render(
      <MyIssueList
        items={[item({ state: 'unknown', commentCount: null, sources: ['cindy-tool'] })]}
      />,
    );
    const meta = screen.getByText(/#1061/).textContent!;
    expect(meta).toContain('issueTracker.mine.statusUnknown');
    expect(meta).toContain('issueTracker.mine.sourceCindy');
    // 拿不到评论数时不显示「0 条评论」这种误导信息。
    expect(meta).not.toContain('commentCount');
  });

  it('评论数 0 与 null 都不渲染,但两者是不同语义(0 = 已知没人回复)', () => {
    // 判据必须是显式的 !== null && > 0:写成 falsy 会让 0 与「未知」在代码里混为一谈,
    // 后续要改成「0 也展示」时会踩空。
    render(<MyIssueList items={[item({ commentCount: 0 })]} />);
    expect(screen.getByText(/#1061/).textContent).not.toContain('commentCount');
    cleanup();
    render(<MyIssueList items={[item({ commentCount: 1 })]} />);
    expect(screen.getByText(/#1061/).textContent).toContain('issueTracker.mine.commentCount:1');
  });

  it('同时命中两个来源时都标出来', () => {
    render(<MyIssueList items={[item({ sources: ['cindy-tool', 'github-account'] })]} />);
    const meta = screen.getByText(/#1061/).textContent!;
    expect(meta).toContain('issueTracker.mine.sourceCindy');
    expect(meta).toContain('issueTracker.mine.sourceGithub');
  });

  it('类型为 null 时不渲染类型段', () => {
    render(<MyIssueList items={[item({ type: null })]} />);
    expect(screen.getByText(/#1061/).textContent).not.toContain('issueTracker.type.');
  });

  it('点击整行走 openExternal 打开 GitHub', () => {
    const openExternal = vi.fn();
    (window as unknown as { electronAPI: { openExternal: typeof openExternal } }).electronAPI = {
      openExternal,
    };
    render(<MyIssueList items={[item()]} />);
    fireEvent.click(screen.getByRole('button'));
    expect(openExternal).toHaveBeenCalledWith('https://github.com/makecindy/cindy/issues/1061');
  });

  it('每条 issue 一行,按传入顺序渲染', () => {
    render(<MyIssueList items={[item({ number: 3 }), item({ number: 2 }), item({ number: 1 })]} />);
    const rows = screen.getAllByRole('button');
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.textContent!.match(/#\d+/)![0])).toEqual(['#3', '#2', '#1']);
  });
});
