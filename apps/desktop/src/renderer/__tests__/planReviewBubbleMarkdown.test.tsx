// @vitest-environment jsdom
//
// 计划审阅气泡的计划正文必须走 Markdown 渲染,而不是直出源码。
// 回归背景:approved 态原本用 <pre> 打印 planReviewPlan,聊天记录里回看时满屏
// `#` / `**` / 表格竖线,和底部 Plan Viewer Card 的排版观感完全脱节。

import { cleanup, render, screen } from '@testing-library/react';
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
      {content}
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
    expect(markdown.textContent).toBe(PLAN);
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

  it('expired / cancelled 态同样渲染 Markdown、同样带会话上下文(只是不给展开按钮)', () => {
    for (const status of ['expired', 'cancelled'] as const) {
      const { unmount } = render(
        <PlanReviewBubble
          message={planReviewMessage({ planReviewStatus: status })}
          workingDir="/tmp/repo"
          currentSessionId="sess-42"
        />,
      );
      expect(screen.getByTestId('markdown').textContent).toBe(PLAN);
      expect(screen.getByTestId('markdown').getAttribute('data-session-id')).toBe('sess-42');
      expect(screen.queryByRole('button')).toBeNull();
      unmount();
    }
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
