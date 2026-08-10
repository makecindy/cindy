// @vitest-environment jsdom
//
// 计划审阅气泡的计划正文必须走 Markdown 渲染,而不是直出源码。
// 回归背景:approved 态原本用 <pre> 打印 planReviewPlan,聊天记录里回看时满屏
// `#` / `**` / 表格竖线,和底部 Plan Viewer Card 的排版观感完全脱节。

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// MarkdownRenderer 本体拖着 rehype-highlight / mermaid / lightbox 一串重依赖,
// 这里只关心"计划正文有没有交给它渲染",用桩替掉即可。
vi.mock('@/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({
    content,
    workingDir,
    currentSessionId,
    currentSessionTitle,
    localFileRefs,
  }: {
    content: string;
    workingDir: string;
    currentSessionId?: string;
    currentSessionTitle?: string | null;
    localFileRefs?: readonly { name: string }[];
  }) => (
    <div
      data-testid="markdown"
      data-working-dir={workingDir}
      data-session-id={currentSessionId ?? ''}
      data-session-title={currentSessionTitle ?? ''}
      data-file-refs={(localFileRefs ?? []).map((r) => r.name).join(',')}
    >
      <span data-testid="markdown-content">{content}</span>
      {/* 折叠用例要的两个可聚焦元素:一个完全在折叠视窗内,一个被裁到线下。
          位置由 data-test-bottom 喂给下面 mock 的 getBoundingClientRect。 */}
      <a href="https://example.com" data-testid="visible-link" data-test-bottom="40">
        可见链接
      </a>
      <a href="https://example.com" data-testid="clipped-link" data-test-bottom="400">
        被裁链接
      </a>
    </div>
  ),
}));

import { PlanReviewBubble } from '@/components/chat/PlanReviewBubble';
import type { ChatMessage } from '@/lib/makerChatStore';

const PLAN = '# 计划标题\n\n- 第一步\n- 第二步\n';

function planReviewMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    clientId: 'plan-1',
    role: 'plan_review',
    content: '',
    planReviewPlan: PLAN,
    planReviewStatus: 'approved',
    ...overrides,
  } as ChatMessage;
}

/** 限高容器 = MarkdownRenderer 桩的祖父节点(桩 → 测高 div → 限高容器)。 */
function collapsedBoxOf(markdown: HTMLElement): HTMLElement {
  const box = markdown.parentElement?.parentElement;
  if (!box) throw new Error('collapsed box not found');
  return box;
}

/**
 * jsdom 不做布局:offsetHeight 恒 0、getBoundingClientRect 全返回 0,所以
 * overflowing=true 与"元素是否被裁"两条分支都测不到。这里把两者一起打桩 ——
 * 高度顶到超过折叠上限,矩形则按元素自带的 data-test-bottom 返回底边。
 */
function installLayoutStubs(): () => void {
  const savedHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  const savedRect = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'getBoundingClientRect',
  );

  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 9999,
  });
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement) {
      const bottom = Number(this.dataset.testBottom ?? 0);
      return {
        top: 0,
        bottom,
        left: 0,
        right: 0,
        width: 0,
        height: bottom,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    },
  });

  return () => {
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    if (savedHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', savedHeight);
    else delete proto.offsetHeight;
    if (savedRect) Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', savedRect);
    else delete proto.getBoundingClientRect;
  };
}

function withOverflowingContent(run: () => void) {
  const restore = installLayoutStubs();
  try {
    run();
  } finally {
    restore();
  }
}

async function withOverflowingContentAsync(run: () => Promise<void>) {
  const restore = installLayoutStubs();
  try {
    await run();
  } finally {
    restore();
  }
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PlanReviewBubble 计划正文渲染', () => {
  it('approved 态把计划交给 MarkdownRenderer,并透传 workingDir', () => {
    const { container } = render(
      <PlanReviewBubble message={planReviewMessage()} workingDir="/tmp/repo" />,
    );

    const markdown = screen.getByTestId('markdown');
    expect(screen.getByTestId('markdown-content').textContent).toBe(PLAN);
    expect(markdown.getAttribute('data-working-dir')).toBe('/tmp/repo');
    // 源码直出的 <pre> 不再出现。
    expect(container.querySelector('pre')).toBeNull();
  });

  // 回归护栏(PR #1083 review):计划正文是会话消息内容,必须拿到与
  // AssistantMessage 同一套解析上下文。currentSessionId 缺失时
  // MarkdownRenderer 的 remoteMediaOrigin 恒 undefined,device / ssh 会话里
  // 计划内的图片会绕过 cindy-remote-media:// 改写而坏图。
  it('把会话解析上下文透传给 MarkdownRenderer', () => {
    render(
      <PlanReviewBubble
        message={planReviewMessage()}
        workingDir="/tmp/repo"
        currentSessionId="sess-42"
        currentSessionTitle="改计划审阅气泡"
        localFileRefs={[{ name: 'spec.docx', absPath: '/tmp/repo/spec.docx' } as never]}
      />,
    );

    const markdown = screen.getByTestId('markdown');
    expect(markdown.getAttribute('data-session-id')).toBe('sess-42');
    expect(markdown.getAttribute('data-session-title')).toBe('改计划审阅气泡');
    expect(markdown.getAttribute('data-file-refs')).toBe('spec.docx');
  });

  it('expired / cancelled 态同样渲染 Markdown、同样带会话上下文', () => {
    for (const status of ['expired', 'cancelled'] as const) {
      const { unmount } = render(
        <PlanReviewBubble
          message={planReviewMessage({ planReviewStatus: status })}
          workingDir="/tmp/repo"
          currentSessionId="sess-42"
        />,
      );
      expect(screen.getByTestId('markdown-content').textContent).toBe(PLAN);
      expect(screen.getByTestId('markdown').getAttribute('data-session-id')).toBe('sess-42');
      unmount();
    }
  });

  it('内容没超过折叠高度时不折叠:不动 tab 序、不出展开按钮', () => {
    // jsdom 里 offsetHeight 恒 0,等价于"内容没超高"这一分支。
    render(<PlanReviewBubble message={planReviewMessage()} workingDir="/tmp/repo" />);

    expect(collapsedBoxOf(screen.getByTestId('markdown')).hasAttribute('inert')).toBe(false);
    expect(screen.getByTestId('clipped-link').hasAttribute('tabindex')).toBe(false);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('revised 态的用户反馈保持纯文本,不当 Markdown 解析', () => {
    render(
      <PlanReviewBubble
        message={planReviewMessage({
          planReviewStatus: 'revised',
          planReviewFeedback: '# 这是我原话里的井号',
        })}
        workingDir="/tmp/repo"
      />,
    );

    expect(screen.queryByTestId('markdown')).toBeNull();
    expect(screen.getByText('# 这是我原话里的井号')).toBeTruthy();
  });

  // 回归护栏。两条不变量必须同时成立,任何一半单独满足都是缺陷:
  //   (a) 被裁掉的控件不可用键盘激活 —— overflow-hidden + mask 只挡"看得见",
  //       否则键盘能聚焦一个隐形链接,焦点进入还会滚动容器把折叠预览顶掉;
  //   (b) 可见的正文照常可选、可见控件照常可交互 —— DESIGN.md §14.1 要求消息
  //       正文默认可选,所以不能靠整块 inert 去满足 (a)。
  describe('折叠态', () => {
    it('三态都把被裁控件移出 tab 序、保留可见控件、并给得出展开入口', () => {
      for (const status of ['approved', 'expired', 'cancelled'] as const) {
        withOverflowingContent(() => {
          const { unmount } = render(
            <PlanReviewBubble
              message={planReviewMessage({ planReviewStatus: status })}
              workingDir="/tmp/repo"
            />,
          );

          expect(screen.getByTestId('clipped-link').getAttribute('tabindex')).toBe('-1');
          expect(screen.getByTestId('visible-link').hasAttribute('tabindex')).toBe(false);
          // 不整块 inert:inert 会连带禁掉预览文字的选中。
          expect(collapsedBoxOf(screen.getByTestId('markdown')).hasAttribute('inert')).toBe(false);
          expect(screen.getByRole('button', { name: /showFull/ }).getAttribute('aria-expanded'))
            .toBe('false');
          unmount();
        });
      }
    });

    it('展开后把被裁控件还原回 tab 序', () => {
      withOverflowingContent(() => {
        render(<PlanReviewBubble message={planReviewMessage()} workingDir="/tmp/repo" />);

        expect(screen.getByTestId('clipped-link').getAttribute('tabindex')).toBe('-1');

        fireEvent.click(screen.getByRole('button', { name: /showFull/ }));

        // 原本没有 tabindex 的元素要还原成"没有",不能留下 tabindex="0"。
        expect(screen.getByTestId('clipped-link').hasAttribute('tabindex')).toBe(false);
        expect(screen.getByRole('button', { name: /collapse/ }).getAttribute('aria-expanded'))
          .toBe('true');
      });
    });

    // 回归护栏(PR #2274 review):MarkdownRenderer 的 useResolvedMarkdownTarget
    // 会在初次布局之后把本地路径异步解析成带 tabIndex={0} 的 FileTargetChip。
    // 这种行内替换可能一点尺寸都不改 —— 于是 effect 依赖没变、ResizeObserver
    // 也不响,新 chip 会绕过同步继续留在 tab 序里。靠 MutationObserver 兜住。
    it('延迟出现的可聚焦控件也按位置同步(被裁的摘掉、可见的不动)', async () => {
      await withOverflowingContentAsync(async () => {
        render(<PlanReviewBubble message={planReviewMessage()} workingDir="/tmp/repo" />);

        const body: HTMLElement = screen.getByTestId('markdown');
        // 模拟异步解析就绪:往子树里插入两个 chip,一个在裁剪线下、一个在线上。
        const lateClipped = document.createElement('span');
        lateClipped.setAttribute('role', 'button');
        lateClipped.setAttribute('tabindex', '0');
        lateClipped.dataset.testid = 'late-clipped-chip';
        lateClipped.dataset.testBottom = '500';

        const lateVisible = document.createElement('span');
        lateVisible.setAttribute('role', 'button');
        lateVisible.setAttribute('tabindex', '0');
        lateVisible.dataset.testid = 'late-visible-chip';
        lateVisible.dataset.testBottom = '30';

        body.append(lateClipped, lateVisible);

        await waitFor(() => {
          expect(lateClipped.getAttribute('tabindex')).toBe('-1');
        });
        // 线上的 chip 必须保持可聚焦 —— 它是用户看得见、点得到的控件。
        expect(lateVisible.getAttribute('tabindex')).toBe('0');
      });
    });

    // 回归护栏(PR #2274 review):overflow-hidden 只挡手动滚动。计划里指向折叠线
    // 下标题的内部锚点会调 scrollIntoView() 把预览卷到下半段 —— 既露出本该藏起来
    // 的内容,也让"可见"与 tab 序错位。折叠态遇到程序化滚动应当直接展开。
    it('折叠态被程序化滚动(内部锚点 scrollIntoView)时自动展开并还原 tab 序', () => {
      withOverflowingContent(() => {
        render(<PlanReviewBubble message={planReviewMessage()} workingDir="/tmp/repo" />);

        expect(screen.getByRole('button', { name: /showFull/ }).getAttribute('aria-expanded'))
          .toBe('false');
        expect(screen.getByTestId('clipped-link').getAttribute('tabindex')).toBe('-1');

        const box = collapsedBoxOf(screen.getByTestId('markdown'));
        box.scrollTop = 200;
        fireEvent.scroll(box);

        // 展开:折叠预览不再把内容卷在窗口里。
        expect(screen.getByRole('button', { name: /collapse/ }).getAttribute('aria-expanded'))
          .toBe('true');
        // 卷走导致的可见性变化不会留下错位的 tab 序 —— 展开后全部还原。
        expect(screen.getByTestId('clipped-link').hasAttribute('tabindex')).toBe(false);
        expect(box.scrollTop).toBe(0);
      });
    });
  });

  it('pending 态只有等待提示,不渲染计划正文', () => {
    render(
      <PlanReviewBubble
        message={planReviewMessage({ planReviewStatus: 'pending' })}
        workingDir="/tmp/repo"
      />,
    );

    expect(screen.queryByTestId('markdown')).toBeNull();
    expect(screen.getByText('chat.planReviewBubble.pendingHint')).toBeTruthy();
  });
});
