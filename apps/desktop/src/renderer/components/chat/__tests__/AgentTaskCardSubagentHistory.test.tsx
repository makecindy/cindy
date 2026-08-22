// @vitest-environment jsdom
//
// #3154 codex P1:history reload 后 agent_task_update 不持久化,普通 Subagent 卡
// 没有 update,但 toolCall.toolUseId 已作为 sidebar alias 持久化。详情入口必须用它
// 兜底,否则历史会话里完成的 Subagent 永远点不进右栏面板。

import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openSubagentsTab } = vi.hoisted(() => ({
  openSubagentsTab: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars && Object.keys(vars).length > 0 ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));

vi.mock('@/hooks/useExpandedBlockMemory', () => ({
  useExpandedBlockMemory: () => ({ expanded: true, setExpanded: vi.fn() }),
}));

vi.mock('@/lib/makerTransport', () => ({
  getWorkflowProgressFor: vi.fn(async () => null),
  isRemoteSessionSticky: () => false,
}));

vi.mock('@/features/right-sidebar/lib/openBackgroundTasksTab', () => ({
  openBackgroundTasksTab: vi.fn(),
}));

vi.mock('@/features/right-sidebar/lib/openSubagentsTab', () => ({
  openSubagentsTab,
}));

vi.mock('@/features/right-sidebar/plugins/background-tasks/listSessionTasks', () => ({
  extractWorkflowTaskId: () => undefined,
}));

vi.mock('@/features/right-sidebar/plugins/background-tasks/WorkflowAgentStrip', () => ({
  WorkflowAgentStrip: () => null,
}));

vi.mock('@/features/cc-agent/embeddedSessionNavigation', () => ({
  useSidebarPanelReachable: () => true,
}));

vi.mock('@/components/ui/collapse', () => ({
  Collapse: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/ui/spinner', () => ({
  Spinner: () => null,
}));

vi.mock('@/lib/modelShortLabel', () => ({
  formatModelShortLabel: (model?: string | null) => model ?? undefined,
}));

import { AgentTaskCard } from '../AgentTaskCard';
import type { ChatMessage } from '@/hooks/useCCAgentChat';

function makeToolCall(toolUseId: string, toolName = 'Agent'): ChatMessage {
  return {
    clientId: `c-${toolUseId}`,
    role: 'tool_use',
    content: '',
    toolUseId,
    toolName,
    toolInput: { description: 'scout', prompt: 'do a thing' },
  } as unknown as ChatMessage;
}

function makeControlToolCall(toolUseId: string, toolName: string): ChatMessage {
  return {
    clientId: `c-${toolUseId}`,
    role: 'tool_use',
    content: '',
    toolUseId,
    toolName,
    toolInput: {},
  } as unknown as ChatMessage;
}

describe('AgentTaskCard subagent details entry after history reload', () => {
  beforeEach(() => {
    openSubagentsTab.mockClear();
  });

  it('still opens the subagent panel when update is missing and only toolUseId is known', () => {
    render(
      <MemoryRouter>
        <AgentTaskCard
          toolCall={makeToolCall('persisted-run-alias')}
          result="completed"
          sessionId="lead-1"
        />
      </MemoryRouter>,
    );

    const button = screen.getByRole('button', { name: /viewSubagentDetails/ });
    fireEvent.click(button);

    expect(openSubagentsTab).toHaveBeenCalledWith('lead-1', {
      focusRunId: 'persisted-run-alias',
      focusProvider: expect.any(String),
      userInitiated: true,
    });
  });

  it('does not show the details entry on collab control calls (wait/sendInput/resume/close)', () => {
    // #3154 codex P2:collab:wait / collab:sendInput / collab:resumeAgent /
    // collab:closeAgent 虽是任务卡,但不是 subagent 启动,拿它们的 toolUseId 去
    // 右栏定位不到 run。详情入口只应对真正的 spawn 工具显示。
    for (const controlName of [
      'collab:wait',
      'collab:sendInput',
      'collab:resumeAgent',
      'collab:closeAgent',
    ]) {
      const { unmount } = render(
        <MemoryRouter>
          <AgentTaskCard
            toolCall={makeControlToolCall(`ctrl-${controlName}`, controlName)}
            result="ok"
            sessionId="lead-1"
          />
        </MemoryRouter>,
      );
      expect(
        screen.queryByRole('button', { name: /viewSubagentDetails/ }),
      ).toBeNull();
      unmount();
    }
  });
});
