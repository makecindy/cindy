// @vitest-environment jsdom
//
// Codex 子代理卡与 Claude 子代理卡的形态一致性回归。
//
// Cindy 的子代理 UI 只有一张卡(AgentTaskCard):Claude 靠 SDK 的 task_progress 驱动,
// Codex 此前没有数据源、只能渲染一句「已启动」就地收口。补上子线程实时事件后,两者必须
// 长得一样 —— 同样的 provider·状态·tokens·工具调用数·耗时,且 codex 不多出冗余文案。

import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars && Object.keys(vars).length > 0 ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));

vi.mock('@/hooks/useExpandedBlockMemory', () => ({
  useExpandedBlockMemory: () => ({ expanded: false, setExpanded: vi.fn() }),
}));

vi.mock('@/lib/makerTransport', () => ({
  getWorkflowProgressFor: vi.fn(async () => null),
  isRemoteSessionSticky: () => false,
}));

vi.mock('@/features/right-sidebar/lib/openBackgroundTasksTab', () => ({
  openBackgroundTasksTab: vi.fn(),
}));

vi.mock('@/features/right-sidebar/plugins/background-tasks/listSessionTasks', () => ({
  extractWorkflowTaskId: () => undefined,
}));

vi.mock('@/features/right-sidebar/plugins/background-tasks/WorkflowAgentStrip', () => ({
  WorkflowAgentStrip: () => null,
}));

vi.mock('@/features/cc-agent/embeddedSessionNavigation', () => ({
  useSidebarPanelReachable: () => false,
}));

vi.mock('@/components/ui/collapse', () => ({
  Collapse: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('@/lib/modelShortLabel', () => ({
  formatModelShortLabel: (model?: string | null) => model ?? undefined,
}));

import { AgentTaskCard } from '../AgentTaskCard';
import type { AgentTaskUpdate, ChatMessage } from '@/hooks/useCCAgentChat';

function spawnToolCall(): ChatMessage {
  return {
    clientId: 'c1',
    role: 'tool_use',
    content: '',
    toolUseId: 'spawn-1',
    toolName: 'collab:spawn',
    toolInput: { name: '/root/scout', agentThreadId: 't-2' },
  } as unknown as ChatMessage;
}

const liveCodexUpdate: AgentTaskUpdate = {
  provider: 'codex',
  taskId: 'spawn-1',
  parentToolUseId: 'spawn-1',
  status: 'running',
  title: '/root/scout',
  usage: { totalTokens: 143615, toolUses: 25, durationMs: 170_000 },
};

describe('AgentTaskCard codex subagent live state', () => {
  it('shows the same meta row as a claude subagent card', () => {
    const { container } = render(
      <AgentTaskCard toolCall={spawnToolCall()} result="/root/scout" update={liveCodexUpdate} />,
    );
    const text = container.textContent ?? '';

    expect(text).toContain('chat.agentTask.provider.codex');
    expect(text).toContain('chat.agentTask.status.running');
    // tokens / 工具调用数 / 耗时三项都由 update.usage 驱动,与 Claude 卡同一渲染路径。
    expect(text).toContain('chat.agentTask.tokens');
    expect(text).toContain('chat.agentTask.toolUses');
    expect(text).toContain('2m 50s');
  });

  it('drops the "已启动" receipt once live state exists, and never leaks the raw agent path as summary', () => {
    const { container } = render(
      <AgentTaskCard toolCall={spawnToolCall()} result="/root/scout" update={liveCodexUpdate} />,
    );
    const text = container.textContent ?? '';

    // 冗余文案:title 与运行状态已经表达了「已启动」,Claude 卡在运行中也没有这行。
    expect(text).not.toContain('chat.agentTask.subagentStarted');
    // 标题仍是子代理名(agentPath),但不得作为 summary 再出现一次。
    expect(text.match(/\/root\/scout/g) ?? []).toHaveLength(1);
  });

  it('keeps the localized receipt for history replay (no live update)', () => {
    // 历史回放拿不到 live update(agent_task_update 不落库),回执是唯一可读摘要。
    const { container } = render(<AgentTaskCard toolCall={spawnToolCall()} result="/root/scout" />);
    expect(container.textContent ?? '').toContain('chat.agentTask.subagentStarted');
  });

  it('renders terminal codex subagent state instead of staying stuck on running', () => {
    const { container } = render(
      <AgentTaskCard
        toolCall={spawnToolCall()}
        result="/root/scout"
        update={{ ...liveCodexUpdate, status: 'completed' }}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('chat.agentTask.status.completed');
    expect(text).not.toContain('chat.agentTask.status.running');
  });
});
