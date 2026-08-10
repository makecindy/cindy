// @vitest-environment jsdom

import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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

vi.mock('@/features/right-sidebar/lib/openSubagentsTab', () => ({
  openSubagentsTab: vi.fn(),
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

// chip 断言只关心 raw id 是否上屏,短名格式化规则由 modelShortLabel 自己的单测覆盖。
vi.mock('@/lib/modelShortLabel', () => ({
  formatModelShortLabel: (model?: string | null) => model ?? undefined,
}));

import { AgentTaskCard } from '../AgentTaskCard';
import type { ChatMessage } from '@/hooks/useCCAgentChat';

function collabToolCall(toolInput: Record<string, unknown>): ChatMessage {
  return {
    clientId: 'c1',
    role: 'tool_use',
    content: '',
    toolUseId: 'item_1',
    toolName: 'collab:spawn',
    toolInput,
  } as unknown as ChatMessage;
}

function chipText(container: HTMLElement): string | null {
  const chip = container.querySelector('[data-agent-task-model-chip="true"]');
  return chip ? chip.textContent : null;
}

describe('AgentTaskCard subagent model chip (codex collab)', () => {
  it('shows model and localized effort from explicit spawn params', () => {
    const { container } = render(
      <AgentTaskCard
        toolCall={collabToolCall({
          prompt: 'survey startup path',
          model: 'gpt-5.6-terra',
          reasoningEffort: 'low',
        })}
      />,
    );
    expect(chipText(container)).toBe('gpt-5.6-terra · effortLevels.low');
  });

  it('shows an effort-only chip when spawn overrides effort but inherits the model', () => {
    const { container } = render(
      <AgentTaskCard toolCall={collabToolCall({ prompt: 'p', reasoningEffort: 'xhigh' })} />,
    );
    expect(chipText(container)).toBe('effortLevels.xhigh');
  });

  it('renders no chip when spawn params carry neither model nor effort (inherited defaults)', () => {
    // 默认继承主模型时不猜继承值 —— 宁缺毋滥。
    const { container } = render(<AgentTaskCard toolCall={collabToolCall({ prompt: 'p' })} />);
    expect(chipText(container)).toBeNull();
  });

  it('keeps the minimal effort badge (protocol-legal even though settings whitelist omits it)', () => {
    const { container } = render(
      <AgentTaskCard toolCall={collabToolCall({ prompt: 'p', reasoningEffort: 'minimal' })} />,
    );
    expect(chipText(container)).toBe('effortLevels.minimal');
  });

  it('ignores unknown effort values instead of leaking raw strings into the UI', () => {
    const { container } = render(
      <AgentTaskCard toolCall={collabToolCall({ prompt: 'p', reasoningEffort: 'bogus' })} />,
    );
    expect(chipText(container)).toBeNull();
  });

  it('localizes the spawn receipt instead of echoing the raw agent path', () => {
    // translator 的 fullText 是纯数据(=input.name);卡片按 locale 组装句子。
    const { container } = render(
      <AgentTaskCard
        toolCall={collabToolCall({ name: '/root/survey_startup' })}
        result="/root/survey_startup"
      />,
    );
    expect(container.textContent).toContain('chat.agentTask.subagentStarted');
    expect(container.textContent).not.toContain('/root/survey_startup started');
  });

  it('keeps the claude-code path unchanged (subagentModel prop wins for cc cards)', () => {
    const ccToolCall = {
      clientId: 'c2',
      role: 'tool_use',
      content: '',
      toolUseId: 'toolu_1',
      toolName: 'Agent',
      toolInput: { description: 'Explore repo' },
    } as unknown as ChatMessage;
    const { container } = render(
      <AgentTaskCard toolCall={ccToolCall} subagentModel="claude-sonnet-5" />,
    );
    expect(chipText(container)).toBe('claude-sonnet-5');
  });

  it.each([
    ['partial observation', 'codex/gpt-5.5', 'gpt-5.6-terra'],
    ['conflicting observations', 'codex/gpt-5.5', 'codex/gpt-5.6-sol'],
  ])(
    'does not restore a cleared V1 multi-receiver model after reload (%s)',
    (_caseName, firstObservedModel, spawnModel) => {
      const toolCall = collabToolCall({
        prompt: 'fan out',
        receiverThreadIds: ['thread-a', 'thread-b'],
        model: spawnModel,
      });
      const { container, rerender } = render(
        <AgentTaskCard
          toolCall={toolCall}
          subagentModel={firstObservedModel}
          update={{
            provider: 'codex',
            taskId: 'item_1',
            status: 'running',
            model: null,
          }}
        />,
      );
      expect(chipText(container)).toBeNull();

      // agent_task_update 是 live-only;重载后 update 消失。多 receiver 的一致性
      // 结论无法从首条子消息或 spawn 参数恢复,因此必须继续保持无徽标。
      rerender(<AgentTaskCard toolCall={toolCall} subagentModel={firstObservedModel} />);
      expect(chipText(container)).toBeNull();
    },
  );
});
