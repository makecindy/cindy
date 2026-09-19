// @vitest-environment jsdom

import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { FileDiff, ReviewMarkdownPreviewData } from '@/lib/gitReview.types';

const markdownRendererMock = vi.hoisted(() => vi.fn());

vi.mock('@/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: (props: { content: string; allowPrivilegedLinks?: boolean }) => {
    markdownRendererMock(props);
    return props.content;
  },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { MarkdownDiffPreview } from '../MarkdownDiffPreview';

function diff(overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    id: 'unstaged:docs/readme.md',
    source: 'unstaged',
    path: 'docs/readme.md',
    oldPath: null,
    status: 'modified',
    kind: 'text',
    size: 10,
    additions: 1,
    deletions: 0,
    isBinary: false,
    isSubmodule: false,
    isTooLarge: false,
    mode: { old: null, new: null },
    index: { oldOid: null, newOid: null },
    rawHeader: '',
    rawPatch: '',
    hunks: [],
    error: null,
    ...overrides,
  };
}

describe('MarkdownDiffPreview', () => {
  it('renders untrusted repository markdown with privileged links disabled', async () => {
    const data: ReviewMarkdownPreviewData = {
      diffId: 'unstaged:docs/readme.md',
      content: '# Preview',
      size: 9,
      baseDir: '/repo/docs',
      maxBytes: 1024,
      reason: null,
      error: null,
    };

    render(
      createElement(MarkdownDiffPreview, {
        diff: diff(),
        loadMarkdownPreview: vi.fn(async () => data),
        fallback: createElement('div', null, 'fallback'),
      }),
    );

    await screen.findByText('# Preview');
    await waitFor(() => {
      expect(markdownRendererMock).toHaveBeenCalledWith(
        expect.objectContaining({
          allowPrivilegedLinks: false,
          content: '# Preview',
          workingDir: '/repo/docs',
        }),
      );
    });
  });

  it('renders a word-level revision segment when a pair can be revised', async () => {
    const data: ReviewMarkdownPreviewData = {
      diffId: 'unstaged:docs/readme.md',
      content: 'Alpha\n\nBeta new\n',
      beforeContent: 'Alpha\n\nBeta old\n',
      size: 20,
      baseDir: '/repo/docs',
      maxBytes: 1024,
      reason: null,
      error: null,
    };

    const { container } = render(
      createElement(MarkdownDiffPreview, {
        diff: diff(),
        loadMarkdownPreview: vi.fn(async () => data),
        fallback: createElement('div', null, 'fallback'),
      }),
    );

    await screen.findByText('Alpha');
    // 修改块对折叠为单块修订：只有改动的词带 {-- --} / {++ ++} 标记，
    // 渲染交给打开 reviewAnnotations 的 MarkdownRenderer。
    const revision = container.querySelector('[data-review-markdown-change="revision"]');
    expect(revision?.textContent).toBe('Beta {--old--}{++new++}');
    expect(container.querySelectorAll('[data-review-markdown-change]')).toHaveLength(1);
    await waitFor(() => {
      expect(markdownRendererMock).toHaveBeenCalledWith(
        expect.objectContaining({
          reviewAnnotations: true,
          content: 'Beta {--old--}{++new++}',
        }),
      );
    });
  });

  it('keeps a per-segment wrapper so block spacing survives segment boundaries (regression)', async () => {
    const data: ReviewMarkdownPreviewData = {
      diffId: 'unstaged:docs/readme.md',
      content: ['Alpha', '', 'Beta new', '', 'Gamma', ''].join('\n'),
      beforeContent: ['Alpha', '', 'Beta old', '', 'Gamma', ''].join('\n'),
      size: 32,
      baseDir: '/repo/docs',
      maxBytes: 1024,
      reason: null,
      error: null,
    };

    const { container } = render(
      createElement(MarkdownDiffPreview, {
        diff: diff(),
        loadMarkdownPreview: vi.fn(async () => data),
        fallback: createElement('div', null, 'fallback'),
      }),
    );

    await screen.findByText('Beta {--old--}{++new++}');
    // 每个片段（含未改动的 context 段）都包一层：CSS 才能用 :not(:first-child) /
    // :not(:last-child) 分辨“预览首尾”与“片段边界”——否则段落上的
    // `first:mt-0 last:mb-0` 会在每个边界重新生效，间距塌成 0。
    const segments = container.querySelectorAll('.cindy-review-segments > .cindy-review-segment');
    expect(segments.length).toBeGreaterThan(1);

    const css = readFileSync(
      resolve(__dirname, '..', '..', '..', '..', '..', '..', 'styles', 'globals.css'),
      'utf8',
    );
    expect(css).toContain('.cindy-review-segment:not(:first-child) > .msg-markdown > :first-child');
    expect(css).toContain('.cindy-review-segment:not(:last-child) > .msg-markdown > :last-child');
  });

  it('passes per-segment heading ids and the anchor map to each renderer (regression)', async () => {
    markdownRendererMock.mockClear();
    // 每个片段各一个 MarkdownRenderer，各自跑一次 rehype-slug（每次 reset）—— 重复标题
    // 会掉到不同片段里。计划阶段算全篇 id，再通过 reviewSlugMap 逐段落位，
    // 页内链接重写表同时传给每段（跨片段链接才能落到正确标题）。
    const data: ReviewMarkdownPreviewData = {
      diffId: 'unstaged:docs/readme.md',
      content: ['## 用法', '', '新内容 A', '', '## 用法', '', '新内容 B', ''].join('\n'),
      beforeContent: ['## 用法', '', '旧内容 A', '', '## 用法', '', '旧内容 B', ''].join('\n'),
      size: 64,
      baseDir: '/repo/docs',
      maxBytes: 1024,
      reason: null,
      error: null,
    };

    render(
      createElement(MarkdownDiffPreview, {
        diff: diff(),
        loadMarkdownPreview: vi.fn(async () => data),
        fallback: createElement('div', null, 'fallback'),
      }),
    );

    await waitFor(() => {
      const maps = markdownRendererMock.mock.calls
        .map(([props]) => (props as { reviewSlugMap?: { headingIds?: string[] } }).reviewSlugMap)
        .filter((map): map is { headingIds: string[] } => Array.isArray(map?.headingIds));
      // 两个同名标题各带自己的全篇 id（第二段是 `用法-1`），合起来不重复。
      expect(maps.flatMap((map) => map.headingIds)).toEqual(['用法', '用法-1']);
    });
    // 锚点表随每段一起传（否则跨片段 `#用法-1` 无人重写）。
    for (const call of markdownRendererMock.mock.calls) {
      const props = call[0] as { reviewSlugMap?: { anchorIds?: Record<string, string> } };
      expect(props.reviewSlugMap?.anchorIds?.['用法-1']).toBe('用法-1');
    }
  });

  it('marks an inline code span as a whole inside a revision segment (regression)', async () => {
    const data: ReviewMarkdownPreviewData = {
      diffId: 'unstaged:docs/readme.md',
      content: 'Run `new` now\n',
      beforeContent: 'Run `old` now\n',
      size: 20,
      baseDir: '/repo/docs',
      maxBytes: 1024,
      reason: null,
      error: null,
    };

    const { container } = render(
      createElement(MarkdownDiffPreview, {
        diff: diff(),
        loadMarkdownPreview: vi.fn(async () => data),
        fallback: createElement('div', null, 'fallback'),
      }),
    );

    // 代码跨度是原子：标记包在整段外面（旧跨度删除 + 新跨度新增），不再整行回退。
    await screen.findByText('Run {--`old`--}{++`new`++} now');
    const revision = container.querySelector('[data-review-markdown-change="revision"]');
    expect(revision?.textContent).toBe('Run {--`old`--}{++`new`++} now');
    expect(container.querySelectorAll('[data-review-markdown-change]')).toHaveLength(1);
  });

  it('falls back to block-level segments when the pair cannot be revised', async () => {
    const data: ReviewMarkdownPreviewData = {
      diffId: 'unstaged:docs/readme.md',
      content: '{--新--} 字面标记\n',
      beforeContent: '{--旧--} 字面标记\n',
      size: 20,
      baseDir: '/repo/docs',
      maxBytes: 1024,
      reason: null,
      error: null,
    };

    const { container } = render(
      createElement(MarkdownDiffPreview, {
        diff: diff(),
        loadMarkdownPreview: vi.fn(async () => data),
        fallback: createElement('div', null, 'fallback'),
      }),
    );

    // 源码里已经含 CriticMarkup 定界符（字面 `{--旧--}`）：再插标记会让折叠器错乱，
    // 这种情况仍回退整块装饰（删除线 / 下划线，不含背景色块和 +/- 符号列）。
    await screen.findByText('{--新--} 字面标记');
    const removed = container.querySelector('[data-review-markdown-change="removed"]');
    const added = container.querySelector('[data-review-markdown-change="added"]');
    expect(removed?.textContent).toBe('{--旧--} 字面标记');
    expect(added?.textContent).toBe('{--新--} 字面标记');
    expect(removed?.className).toContain('line-through');
    expect(added?.className).toContain('underline');
    expect(container.querySelectorAll('[data-review-markdown-change]')).toHaveLength(2);
  });

  it('revises an edit around inline code word-level', async () => {
    const data: ReviewMarkdownPreviewData = {
      diffId: 'unstaged:docs/readme.md',
      content: 'Run `cmd` now\n',
      beforeContent: 'Run `cmd` now fast\n',
      size: 20,
      baseDir: '/repo/docs',
      maxBytes: 1024,
      reason: null,
      error: null,
    };

    const { container } = render(
      createElement(MarkdownDiffPreview, {
        diff: diff(),
        loadMarkdownPreview: vi.fn(async () => data),
        fallback: createElement('div', null, 'fallback'),
      }),
    );

    // 删除的片段在行内代码**外侧**：标记可以跨 inline 元素折叠，仍然是词级修订。
    await screen.findByText(/Run/);
    const revision = container.querySelector('[data-review-markdown-change="revision"]');
    expect(revision?.textContent).toContain('{-- fast--}');
    expect(container.querySelectorAll('[data-review-markdown-change]')).toHaveLength(1);
  });

  it('falls back to a plain render when the baseline is unavailable', async () => {
    const data: ReviewMarkdownPreviewData = {
      diffId: 'unstaged:docs/readme.md',
      content: 'Alpha\n\nBeta\n',
      beforeContent: null,
      size: 12,
      baseDir: '/repo/docs',
      maxBytes: 1024,
      reason: null,
      error: null,
    };

    const { container } = render(
      createElement(MarkdownDiffPreview, {
        diff: diff(),
        loadMarkdownPreview: vi.fn(async () => data),
        fallback: createElement('div', null, 'fallback'),
      }),
    );

    await screen.findByText(/Alpha/);
    expect(container.querySelectorAll('[data-review-markdown-change]')).toHaveLength(0);
  });
});
