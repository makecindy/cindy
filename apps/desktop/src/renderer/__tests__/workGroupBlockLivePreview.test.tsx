// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.duration
        ? `${key}:${String(options.duration)}`
        : options?.count
          ? `${key}:${String(options.count)}`
          : key,
  }),
}));

// The work-group interaction is under test. Keep direct tool rows lightweight
// while exposing the raw-command flag and status forwarded by WorkGroupBlock.
vi.mock('@/components/chat/AgentActionRow', () => ({
  AgentActionRow: (props: {
    message: ChatMessage;
    showRawCommand?: boolean;
    status?: 'running' | 'done';
    toolResult?: string;
    intentOverride?: { action: string; target?: string };
  }) => {
    const toolInput = props.message.toolInput as { command?: unknown } | undefined;
    const command = typeof toolInput?.command === 'string'
      ? toolInput.command
      : props.message.clientId;
    return createElement(
      'div',
      {
        'data-testid': 'direct-tool',
        'data-show-raw': String(Boolean(props.showRawCommand)),
        'data-result': props.toolResult,
        'data-intent': props.intentOverride?.action,
        'data-target': props.intentOverride?.target,
        'aria-label': `chat.agentActionRow.status.${props.status ?? 'done'}`,
      },
      command,
    );
  },
}));

vi.mock('@/components/chat/ThinkingCard', () => ({
  ThinkingCard: (props: { content: string; isRedacted?: boolean }) =>
    createElement(
      'div',
      {
        'data-testid': 'redacted-thinking',
        'data-content': props.content,
        'data-redacted': String(Boolean(props.isRedacted)),
      },
      'chat.thinking.redacted',
    ),
  formatDuration: (ms: number) => `${Math.max(1, Math.round(ms / 1000))}s`,
}));

import {
  WorkGroupBlock,
  collectLiveWorkActivities,
  type WorkGroupChild,
} from '@/components/chat/WorkGroupBlock';
import { __test_internals as expandMemory } from '@/hooks/useExpandedBlockMemory';
import type { ChatMessage } from '@/lib/makerChatStore';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => expandMemory.reset());

const mkTool = (id: string, command = id): ChatMessage => ({
  clientId: id,
  role: 'tool_use',
  content: '',
  toolUseId: `tu-${id}`,
  toolName: 'exec',
  toolInput: { command },
});

const mkThinking = (id: string, content: string): ChatMessage => ({
  clientId: id,
  role: 'thinking',
  content,
  isStreaming: true,
  thinkingDurationMs: content ? 1000 : 2000,
});

const tools = (
  key: string,
  toolCalls: ChatMessage[],
  resultMap = new Map<string, string>(),
  settledIds = new Set<string>(),
): WorkGroupChild => ({ kind: 'tools', key, toolCalls, resultMap, settledIds });

const thinking = (message: ChatMessage): WorkGroupChild => ({
  kind: 'thinking',
  key: `msg-${message.clientId}`,
  message,
});

const rendered = (key: string, text: string): WorkGroupChild => ({
  kind: 'rendered',
  key,
  renderNode: () => createElement('div', { 'data-testid': 'assistant-progress' }, text),
});

const group = (
  key: string,
  durationMs: number,
  childItems: WorkGroupChild[],
  isStreaming = false,
): WorkGroupChild => ({
  kind: 'group',
  key,
  blockId: `work:${key}`,
  durationMs,
  isStreaming,
  childItems,
});

function clickGroup(label: string) {
  const button = screen.getByText(label).closest('button');
  if (!button) throw new Error(`Missing work-group button: ${label}`);
  fireEvent.click(button);
}

describe('WorkGroupBlock — running latest-five preview', () => {
  it('keeps the latest five tools/reasoning rows in chronological order and drops empty thinking', async () => {
    const children: WorkGroupChild[] = [
      tools('seg-1', [mkTool('t1'), mkTool('t2')]),
      thinking(mkThinking('th1', 'first reasoning summary')),
      thinking(mkThinking('empty', '')),
      tools('seg-2', [mkTool('t3'), mkTool('t4')]),
      thinking(mkThinking('th2', 'latest reasoning summary')),
    ];

    const activities = collectLiveWorkActivities(children, true);
    expect(activities.map((activity) => activity.key)).toEqual(['t2', 'th1', 't3', 't4', 'th2']);
    expect(activities.some((activity) => activity.key === 'empty')).toBe(false);

    render(
      createElement(WorkGroupBlock, {
        blockId: 'work:t1',
        isStreaming: true,
        childItems: children,
      }),
    );
    expect(document.querySelectorAll('[data-live-work-activity]')).toHaveLength(5);
    clickGroup('chat.workGroup.working');
    expect(document.querySelectorAll('[data-live-work-activity]')).toHaveLength(6);
    expect(screen.getAllByTestId('direct-tool')[0].textContent).toBe('t1');
    clickGroup('chat.workGroup.working');
    // 收起是一次性 200ms 高度动画,展开体在动画结束后卸载(jsdom 无
    // transitionend,由 Collapse 的兜底定时器卸载)——等待卸载完成再断言。
    // 契约不变:收起后的内容不留在 DOM。
    await waitFor(() =>
      expect(document.querySelectorAll('[data-live-work-activity]')).toHaveLength(5),
    );
    expect(screen.queryByText('t1')).toBeNull();
  });

  it('renders one reasoning row that updates in place as the same block receives deltas', () => {
    const { rerender } = render(
      createElement(WorkGroupBlock, {
        blockId: 'work:t1',
        isStreaming: true,
        childItems: [thinking(mkThinking('th1', '**inspecting**'))],
      }),
    );
    expect(screen.getAllByText('inspecting')).toHaveLength(1);
    expect(screen.queryByText('**inspecting**')).toBeNull();

    rerender(
      createElement(WorkGroupBlock, {
        blockId: 'work:t1',
        isStreaming: true,
        childItems: [thinking(mkThinking('th1', '**inspecting the renderer**'))],
      }),
    );
    expect(screen.queryByText('inspecting')).toBeNull();
    expect(screen.getAllByText('inspecting the renderer')).toHaveLength(1);
    expect(document.querySelectorAll('[data-live-work-activity="thinking"]')).toHaveLength(1);
  });

  it('continues updating an expanded live reasoning row as deltas arrive', () => {
    const { rerender } = render(
      createElement(WorkGroupBlock, {
        blockId: 'work:t1',
        isStreaming: true,
        childItems: [thinking(mkThinking('th1', 'initial\nreasoning'))],
      }),
    );

    const thinkingButton = screen.getByText('initial reasoning').closest('button');
    if (!thinkingButton) throw new Error('Missing live thinking row');
    fireEvent.click(thinkingButton);
    expect(thinkingButton.getAttribute('aria-expanded')).toBe('true');

    rerender(
      createElement(WorkGroupBlock, {
        blockId: 'work:t1',
        isStreaming: true,
        childItems: [thinking(mkThinking('th1', 'initial reasoning\nwith more detail'))],
      }),
    );

    const updatedThinkingButton = screen
      .getByText('initial reasoning with more detail')
      .closest('button');
    expect(updatedThinkingButton?.getAttribute('aria-expanded')).toBe('true');
  });

  it('shows complete commandActions as separate rows and summarizes pure exploration', () => {
    const command = mkTool('exec-1', 'cat src/a.ts && rg TODO src');
    command.toolInput = {
      command: 'cat src/a.ts && rg TODO src',
      cwd: '/repo',
      commandActions: [
        { type: 'read', command: 'cat src/a.ts', name: 'a.ts', path: 'src/a.ts' },
        { type: 'search', command: 'rg TODO src', query: 'TODO', path: 'src' },
      ],
    };

    const { rerender } = render(
      createElement(WorkGroupBlock, {
        blockId: 'work:exec-1',
        isStreaming: true,
        childItems: [tools('seg-1', [command])],
      }),
    );

    const rows = screen.getAllByTestId('direct-tool');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.getAttribute('data-intent'))).toEqual(['read', 'search']);

    rerender(
      createElement(WorkGroupBlock, {
        blockId: 'work:exec-1',
        isStreaming: false,
        durationMs: 4_000,
        childItems: [tools('seg-1', [command])],
      }),
    );
    expect(screen.getByText(/chat\.workGroup\.exploration\.read:1/)).toBeTruthy();
    expect(screen.getByText(/chat\.workGroup\.exploration\.search:1/)).toBeTruthy();
  });

  it('offers no toggle while running when the preview already shows everything', () => {
    const childItems = [
      tools('seg-1', [mkTool('t1', 'git status')]),
      thinking(mkThinking('th1', 'checking the\ncurrent state')),
    ];
    const { rerender } = render(
      createElement(WorkGroupBlock, {
        blockId: 'work:t1',
        isStreaming: true,
        childItems,
      }),
    );

    expect(screen.getByText('chat.workGroup.working')).toBeTruthy();
    expect(document.querySelector('[data-live-work-preview="true"]')).toBeTruthy();
    expect(screen.getByTestId('direct-tool').getAttribute('data-show-raw')).toBe('true');

    // 即使运行中的工作组没有更多内容可供外层展开，思考预览行本身也应可点击查看全文。
    const thinkingPreview = screen.getByText('checking the current state').closest('button');
    if (!thinkingPreview) throw new Error('Missing expandable live thinking row');
    thinkingPreview.focus();
    expect(document.activeElement).toBe(thinkingPreview);
    expect(thinkingPreview.className).toContain(
      'focus-visible:ring-[var(--focus-ring)]',
    );
    expect(thinkingPreview.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(thinkingPreview);
    expect(thinkingPreview.getAttribute('aria-expanded')).toBe('true');
    expect(thinkingPreview.textContent).toContain('checking the\ncurrent state');

    // ≤5 条活动且没有 preview 之外的子项:展开不会露出更多内容,组头不再
    // 提供折叠交互 — 无箭头、禁用、点击后预览保持原样。
    const runningButton = screen.getByText('chat.workGroup.working').closest('button');
    if (!runningButton) throw new Error('Missing work-group header button');
    expect(runningButton.hasAttribute('disabled')).toBe(true);
    expect(runningButton.getAttribute('aria-expanded')).toBeNull();
    expect(runningButton.querySelector('svg.lucide-chevron-right')).toBeNull();
    fireEvent.click(runningButton);
    expect(document.querySelector('[data-live-work-preview="true"]')).toBeTruthy();

    rerender(
      createElement(WorkGroupBlock, {
        blockId: 'work:t1',
        isStreaming: false,
        durationMs: 12_000,
        childItems,
      }),
    );
    // 完成态恢复正常折叠交互:默认收起,点开显示完整明细。
    const doneButton = screen.getByText('chat.workGroup.worked:12s').closest('button');
    expect(doneButton?.hasAttribute('disabled')).toBe(false);
    expect(doneButton?.querySelector('svg.lucide-chevron-right')).toBeTruthy();
    expect(screen.queryByTestId('direct-tool')).toBeNull();
    clickGroup('chat.workGroup.worked:12s');
    expect(screen.getByTestId('direct-tool').textContent).toBe('git status');
    expect(screen.getByText('checking the current state')).toBeTruthy();
  });

  it('shares thinking expansion state between the live preview and full work-group view', () => {
    render(
      createElement(WorkGroupBlock, {
        blockId: 'work:t1',
        isStreaming: true,
        childItems: [
          thinking(mkThinking('th1', 'first line\nsecond line')),
          rendered('progress', 'continuing the analysis'),
        ],
      }),
    );

    const livePreview = document.querySelector('[data-live-work-preview="true"]');
    const liveThinkingButton = livePreview?.querySelector<HTMLButtonElement>(
      '[data-live-work-activity="thinking"]',
    );
    if (!liveThinkingButton) throw new Error('Missing live thinking row');
    fireEvent.click(liveThinkingButton);
    expect(liveThinkingButton.getAttribute('aria-expanded')).toBe('true');

    clickGroup('chat.workGroup.working');
    const fullThinkingButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-live-work-activity="thinking"]',
      ),
    ).find((button) => !button.closest('[data-live-work-preview="true"]'));
    expect(fullThinkingButton?.getAttribute('aria-expanded')).toBe('true');

    if (!fullThinkingButton) throw new Error('Missing full thinking row');
    fireEvent.click(fullThinkingButton);
    expect(fullThinkingButton.getAttribute('aria-expanded')).toBe('false');

    clickGroup('chat.workGroup.working');
    const restoredPreviewButton = document
      .querySelector('[data-live-work-preview="true"]')
      ?.querySelector<HTMLButtonElement>('[data-live-work-activity="thinking"]');
    expect(restoredPreviewButton?.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps an inherited expanded state toggleable for single-line long thinking', () => {
    expandMemory.setExpanded('work:t1', true);
    expandMemory.setExpanded('thinking:th1', true);
    render(
      createElement(WorkGroupBlock, {
        blockId: 'work:t1',
        durationMs: 2_000,
        childItems: [
          thinking(mkThinking('th1', 'a single-line reasoning block that is long enough to overflow')),
          rendered('progress', 'continuing the analysis'),
        ],
      }),
    );

    const fullThinkingButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-live-work-activity="thinking"]',
      ),
    ).find((button) => !button.closest('[data-live-work-preview="true"]'));
    expect(fullThinkingButton?.getAttribute('aria-expanded')).toBe('true');
    expect(fullThinkingButton?.hasAttribute('disabled')).toBe(false);
  });

  it('keeps the toggle while running when expansion can reveal more than the preview', () => {
    render(
      createElement(WorkGroupBlock, {
        blockId: 'work:t1',
        isStreaming: true,
        childItems: [
          tools('seg-1', [
            mkTool('t1'),
            mkTool('t2'),
            mkTool('t3'),
            mkTool('t4'),
            mkTool('t5'),
            mkTool('t6'),
          ]),
        ],
      }),
    );

    const button = screen.getByText('chat.workGroup.working').closest('button');
    if (!button) throw new Error('Missing work-group header button');
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.querySelector('svg.lucide-chevron-right')).toBeTruthy();

    clickGroup('chat.workGroup.working');
    expect(screen.getAllByTestId('direct-tool')).toHaveLength(6);
  });

  it('keeps full details across remounts and collapses back to latest five', async () => {
    const childItems = [
      tools('seg-1', [
        mkTool('t1'),
        mkTool('t2'),
        mkTool('t3'),
        mkTool('t4'),
        mkTool('t5'),
        mkTool('t6'),
      ]),
    ];
    const first = render(
      createElement(WorkGroupBlock, {
        blockId: 'work:t1',
        isStreaming: true,
        childItems,
      }),
    );

    clickGroup('chat.workGroup.working');
    expect(screen.getAllByTestId('direct-tool')).toHaveLength(6);
    first.unmount();

    render(
      createElement(WorkGroupBlock, {
        blockId: 'work:t1',
        isStreaming: true,
        childItems,
      }),
    );
    expect(screen.getAllByTestId('direct-tool')).toHaveLength(6);

    clickGroup('chat.workGroup.working');
    // 收起是 200ms 高度动画,展开行以退场冻结帧存续到动画结束后卸载
    // (jsdom 走兜底定时器)——等待卸载后断言只剩 latest-five 预览。
    await waitFor(() => expect(screen.getAllByTestId('direct-tool')).toHaveLength(5));
    expect(screen.queryByText('t1')).toBeNull();
    expect(document.querySelector('[data-live-work-preview="true"]')).toBeTruthy();
  });

  it('falls back to live preview when collapsing restored full details', async () => {
    expandMemory.setExpanded('work:t1', true);
    render(
      createElement(WorkGroupBlock, {
        blockId: 'work:t1',
        isStreaming: true,
        childItems: [
          tools('seg-1', [
            mkTool('t1'),
            mkTool('t2'),
            mkTool('t3'),
            mkTool('t4'),
            mkTool('t5'),
            mkTool('t6'),
          ]),
        ],
      }),
    );

    expect(screen.getAllByTestId('direct-tool')).toHaveLength(6);
    clickGroup('chat.workGroup.working');
    // 同上:退场冻结帧在动画结束后卸载,等待后断言回落到 latest-five。
    await waitFor(() => expect(screen.getAllByTestId('direct-tool')).toHaveLength(5));
    expect(screen.queryByText('t1')).toBeNull();
    expect(document.querySelector('[data-live-work-preview="true"]')).toBeTruthy();
  });

  it('keeps outer assistant text visible while nested actions need one more expansion', () => {
    render(
      createElement(WorkGroupBlock, {
        blockId: 'work:summary-t1',
        durationMs: 20_000,
        childItems: [
          rendered('msg-progress', 'I checked the current state.'),
          group('inner-t1', 12_000, [
            tools('seg-1', [mkTool('t1', 'git status')]),
            thinking(mkThinking('th1', 'checking the current state')),
          ]),
        ],
      }),
    );

    expect(screen.queryByTestId('assistant-progress')).toBeNull();
    clickGroup('chat.workGroup.worked:20s');
    expect(screen.getByTestId('assistant-progress').textContent).toBe('I checked the current state.');
    expect(screen.getByText('chat.workGroup.worked:12s')).toBeTruthy();
    expect(screen.queryByTestId('direct-tool')).toBeNull();
    expect(screen.queryByText('checking the current state')).toBeNull();

    clickGroup('chat.workGroup.worked:12s');
    expect(screen.getByTestId('direct-tool').textContent).toBe('git status');
    expect(screen.getByText('checking the current state')).toBeTruthy();
  });

  it('expands multi-line thinking from its compact single-line row', () => {
    render(
      createElement(WorkGroupBlock, {
        blockId: 'work:t1',
        durationMs: 3_000,
        childItems: [thinking(mkThinking('th1', 'first line\nsecond line'))],
      }),
    );

    clickGroup('chat.workGroup.worked:3s');
    const compactText = screen.getByText('first line second line');
    const thinkingButton = compactText.closest('button');
    expect(thinkingButton?.getAttribute('aria-expanded')).toBe('false');
    if (!thinkingButton) throw new Error('Missing expandable thinking row');
    fireEvent.click(thinkingButton);
    expect(thinkingButton.getAttribute('aria-expanded')).toBe('true');
    expect(thinkingButton.textContent).toContain('first line\nsecond line');
  });

  it('always reserves the 18px trailing chevron slot on thinking rows', () => {
    render(
      createElement(WorkGroupBlock, {
        blockId: 'work:t1',
        isStreaming: true,
        childItems: [
          thinking(mkThinking('short', 'brief')),
          thinking(mkThinking('long', 'first line\nsecond line')),
        ],
      }),
    );

    const rows = document.querySelectorAll<HTMLButtonElement>(
      '[data-live-work-activity="thinking"]',
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.className).toContain('rounded-[8px]');
      const slot = row.lastElementChild;
      expect(slot?.className).toContain('w-[18px]');
      expect(slot?.className).toContain('h-[18px]');
      expect(slot?.className).toContain('ml-auto');
      expect(slot?.className).toContain('rounded-[8px]');
      expect(slot?.className).toContain('group-hover:bg-[var(--cmd-palette-item-hover)]');
    }
    expect(rows[0]?.querySelector('svg.lucide-chevron-right')).toBeNull();
    expect(rows[1]?.querySelector('svg.lucide-chevron-right')).toBeTruthy();
  });

  it('drops empty thinking and renders redacted thinking directly', () => {
    const redacted = { ...mkThinking('hidden', ''), thinkingRedacted: true };
    render(
      createElement(WorkGroupBlock, {
        blockId: 'work:t1',
        childItems: [thinking(mkThinking('empty', '')), thinking(redacted)],
      }),
    );

    clickGroup('chat.workGroup.workDetails');
    expect(document.querySelectorAll('[data-live-work-activity="thinking"]')).toHaveLength(0);
    expect(screen.getAllByTestId('redacted-thinking')).toHaveLength(1);
    expect(screen.getByTestId('redacted-thinking').getAttribute('data-redacted')).toBe('true');
  });

  it('marks result/settled tools done and only unresolved tools running', () => {
    render(
      createElement(WorkGroupBlock, {
        blockId: 'work:t1',
        isStreaming: true,
        childItems: [
          tools(
            'seg-1',
            [mkTool('result'), mkTool('settled'), mkTool('pending')],
            new Map([['result', 'ok']]),
            new Set(['settled']),
          ),
        ],
      }),
    );

    expect(screen.getAllByLabelText('chat.agentActionRow.status.done')).toHaveLength(2);
    expect(screen.getAllByLabelText('chat.agentActionRow.status.running')).toHaveLength(1);
  });
});
