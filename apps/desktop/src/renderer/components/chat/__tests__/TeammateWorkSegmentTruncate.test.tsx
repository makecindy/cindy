// @vitest-environment jsdom
// 测试价值
// - 生产入口与可观察结果：`TeammateWorkSegment`（伙伴过程标题的用户可见出口）。
//   可展开工具段折叠态单行截断且悬停提示完整摘要，展开态恢复完整折行；不可展开的
//   thinking 段保留原有折行样式。失效后果：长 ACP 命令撑满聊天窗、折叠态读不到被
//   截断的原文，或 thinking 行被意外截断。
// - Bug／规则依据：#13720（折叠摘要缺 truncate，已由 #13728 在主干落地）；本用例锁定
//   该截断契约，并覆盖主干修复尚缺的「悬停显示被截断原文」。
// - 现有覆盖缺口：WorkGroupBlock / TeammateWorkSegment 没有组件测试；#13728 只有
//   teammate-process fixture 的视觉用例，组件层的三个分支都未被回归保护。
// - 最小失败输入：① description 为长多行命令的工具段（折叠态缺 title 提示）；
//   ② 仅 thinking child 的无工具段（不得套用折叠截断）。
// - tier：unit（jsdom 真实组件入口，无 IO）；可见布局由 teammate-process UI fixture 验证。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { TeammateWorkSegment } from '../WorkGroupBlock';
import { EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES } from '@/cindy-brain/PluginUiContributions';
import type { ChatMessage } from '@/lib/makerChatStore';

const stableT = (key: string) => key;
vi.mock('@/hooks/useStableTranslation', () => ({
  useStableTranslation: () => ({ t: stableT }),
}));

const LONG_COMMAND = [
  "python3 - <<'PY'",
  'import numpy as np',
  'data = np.loadtxt("series.csv", delimiter=",", skiprows=1)',
  'print(np.convolve(data, np.ones(50) / 50, mode="valid").tolist())',
  'PY',
].join('\n');

function toolsChild() {
  const message = {
    clientId: 'msg-acp-long-command',
    content: '',
    role: 'tool_use',
    toolName: 'bash',
    // 弱模型/ACP 上报常把整条多行命令同时塞进 description——label 取 description
    // 原文（formatToolRowText 不截断），正是 #13720 撑屏的输入形态。
    toolInput: { command: LONG_COMMAND, description: LONG_COMMAND },
  } as unknown as ChatMessage;
  return {
    kind: 'tools' as const,
    key: 'seg-tools',
    toolCalls: [message],
    resultMap: new Map([['msg-acp-long-command', 'ok']]),
    settledIds: new Set(['msg-acp-long-command']),
  };
}

function renderSegment(blockId: string) {
  const view = render(
    <TeammateWorkSegment blockId={blockId} childItems={[toolsChild()]}
      pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES} />,
  );
  const button = view.container.querySelector<HTMLElement>('[data-teammate-segment] button[data-scroll-disclosure-header]');
  if (!button) throw new Error('segment header button not found');
  return { view, button };
}

function titleSpan(button: HTMLElement) {
  const span = button.querySelector('span.min-w-0');
  if (!span) throw new Error('title span not found');
  return span as HTMLElement;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('TeammateWorkSegment 折叠摘要截断与悬停原文（#13720）', () => {
  it('折叠态：标题单行截断并以 title 提示原文', () => {
    const { button } = renderSegment('work:test-segment');
    const span = titleSpan(button);
    expect(span.textContent).toContain('python3');
    expect(span.className).toContain('truncate');
    expect(span.className).not.toContain('break-words');
    expect(span.getAttribute('title')).toContain('python3');
  });

  it('展开态：标题恢复完整折行并移除 title', () => {
    const { button } = renderSegment('work:test-segment-open');
    fireEvent.click(button);
    const span = titleSpan(button);
    expect(span.className).toContain('break-words');
    expect(span.className).not.toContain('truncate');
    expect(span.textContent).toBe(LONG_COMMAND);
    expect(span.getAttribute('title')).toBeNull();
  });

  it('无工具的 thinking 行保留原有折行显示，不套用折叠按钮截断', () => {
    const message = {
      clientId: 'thinking-long-title',
      content: LONG_COMMAND,
      role: 'thinking',
    } as unknown as ChatMessage;
    const view = render(
      <TeammateWorkSegment blockId="work:thinking-only" childItems={[{ kind: 'thinking', key: 'thinking', message }]}
        pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES} />,
    );
    const span = view.container.querySelector<HTMLElement>('[data-teammate-segment] span.min-w-0');
    if (!span) throw new Error('thinking summary span not found');
    expect(span.className).toContain('break-words');
    expect(span.className).not.toContain('truncate');
    expect(span.getAttribute('title')).toBeNull();
  });
});
