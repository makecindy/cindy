// @vitest-environment jsdom

import { createElement } from 'react';
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
