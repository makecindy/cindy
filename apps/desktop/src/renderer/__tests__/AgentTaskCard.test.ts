// @vitest-environment jsdom

import React from 'react';
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      if (key === 'chat.agentTask.provider.claude') return 'Claude Code';
      if (key === 'chat.agentTask.provider.codex') return 'Codex';
      if (key === 'chat.agentTask.status.completed') return 'Completed';
      if (key === 'chat.agentTask.status.running') return 'Running';
      if (key === 'chat.agentTask.tokens') return `${vars?.count} tokens`;
      if (key === 'chat.agentTask.toolUses') return `${vars?.count} tool uses`;
      if (key === 'chat.agentTask.workflowProgressLine') {
        return `${vars?.phase} · ${vars?.done}/${vars?.total} Agent`;
      }
      if (key === 'chat.agentTask.workflowProgressCount') {
        return `${vars?.done}/${vars?.total} Agent`;
      }
      return key;
    },
  }),
}));

vi.mock('@/hooks/useExpandedBlockMemory', () => ({
  useExpandedBlockMemory: () => ({
    expanded: true,
    setExpanded: vi.fn(),
  }),
}));

const { openBackgroundTasksTabMock } = vi.hoisted(() => ({
  openBackgroundTasksTabMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/features/right-sidebar/lib/openBackgroundTasksTab', () => ({
  openBackgroundTasksTab: openBackgroundTasksTabMock,
}));

const { getWorkflowProgressForMock } = vi.hoisted(() => ({
  getWorkflowProgressForMock: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/makerTransport', () => ({
  isRemoteSessionSticky: () => false,
  getWorkflowProgressFor: getWorkflowProgressForMock,
}));

import { AgentTaskCard } from '@/components/chat/AgentTaskCard';
import { SessionNavigationModeProvider } from '@/features/cc-agent/embeddedSessionNavigation';

/**
 * 面板入口的 affordance 判据是「本会话的右栏 bucket 通过当前交互可达」，由路由
 * 主实例或可见 split pane 经 SessionNavigationModeProvider 声明（见
 * useSidebarPanelReachable）。默认 fail closed：没声明 = 打不开 = 不给假入口。
 */
const withPanelHost = (
  hostSessionId: string,
  element: React.ReactElement,
  mode: 'route-owner' | 'split-pane' = 'route-owner',
) =>
  React.createElement(SessionNavigationModeProvider, {
    mode,
    sidebarPanelHostSessionId: hostSessionId,
    children: element,
  });

describe('AgentTaskCard', () => {
  it('renders the full expanded task result instead of truncating it', () => {
    const tail = 'TAIL_MARKER_KEPT_VISIBLE';
    const longResult = `Summary start\n\n${'x'.repeat(500)}\n${tail}`;

    const { container } = render(
      React.createElement(AgentTaskCard, {
        result: longResult,
        update: {
          provider: 'claude-code',
          taskId: 'task-1',
          status: 'completed',
          title: 'Inspect files',
        },
      }),
    );

    expect(container.textContent).toContain(tail);
    expect(container.textContent).toContain('Summary start');
  });

  it('prefers the paired tool result over task update summaries', () => {
    const { container } = render(
      React.createElement(AgentTaskCard, {
        result: 'Final answer from the Agent tool_result',
        update: {
          provider: 'claude-code',
          taskId: 'task-1',
          status: 'completed',
          title: 'Inspect files',
          summary: 'Task notification summary only',
        },
      }),
    );

    expect(container.textContent).toContain('Final answer from the Agent tool_result');
    expect(container.textContent).not.toContain('Task notification summary only');
  });

  // subagent-model-chip --------------------------------------------------------
  const modelChip = (container: HTMLElement) =>
    container.querySelector('[data-agent-task-model-chip="true"]');

  it('renders the subagent model chip from update.model (live)', () => {
    const { container } = render(
      React.createElement(AgentTaskCard, {
        toolCall: {
          clientId: 'c-live',
          role: 'tool_use',
          content: '',
          toolName: 'Agent',
          toolUseId: 'toolu_LIVE',
          toolInput: { model: 'sonnet' },
        },
        update: {
          provider: 'claude-code',
          taskId: 'task-1',
          status: 'running',
          title: 'Explore the codebase',
          model: 'claude-haiku-4-5-20251001',
        },
      }),
    );
    expect(modelChip(container)?.textContent).toBe('Haiku 4.5');
  });

  it('falls back to subagentModel prop when update is absent (history reload)', () => {
    const { container } = render(
      React.createElement(AgentTaskCard, {
        toolCall: {
          clientId: 'c1',
          role: 'tool_use',
          content: '',
          toolName: 'Agent',
          toolUseId: 'toolu_AGENT',
        },
        result: 'done',
        subagentModel: 'claude-haiku-4-5-20251001',
      }),
    );
    expect(modelChip(container)?.textContent).toBe('Haiku 4.5');
  });

  it('renders no chip when neither update.model nor subagentModel is present', () => {
    const { container } = render(
      React.createElement(AgentTaskCard, {
        update: {
          provider: 'codex',
          taskId: 'task-1',
          status: 'running',
          title: 'Worker task',
        },
      }),
    );
    expect(modelChip(container)).toBeNull();
  });

  it('does not present a Claude Agent request model as the actual model', () => {
    const { container } = render(
      React.createElement(AgentTaskCard, {
        toolCall: {
          clientId: 'c-requested',
          role: 'tool_use',
          content: '',
          toolName: 'Agent',
          toolUseId: 'toolu_REQUESTED',
          toolInput: { model: 'sonnet' },
        },
        result: 'done',
      }),
    );
    expect(modelChip(container)).toBeNull();
  });

  it('keeps the existing Codex collab explicit model chip fallback', () => {
    const { container } = render(
      React.createElement(AgentTaskCard, {
        toolCall: {
          clientId: 'c-codex',
          role: 'tool_use',
          content: '',
          toolName: 'collab:spawn',
          toolUseId: 'call_CODEX',
          toolInput: { model: 'gpt-5.6-terra' },
        },
        result: 'done',
      }),
    );
    expect(modelChip(container)?.textContent).toBe('Gpt 5.6 Terra');
  });

  it('does not fall back to stale history or spawn input after an explicit model clear', () => {
    const { container } = render(
      React.createElement(AgentTaskCard, {
        toolCall: {
          clientId: 'c-clear',
          role: 'tool_use',
          content: '',
          toolName: 'collab:spawn',
          toolUseId: 'toolu_CLEAR',
          toolInput: { model: 'gpt-5.6-terra' },
        },
        update: {
          provider: 'codex',
          taskId: 'task-clear',
          status: 'running',
          model: null,
        },
        subagentModel: 'codex/gpt-5.5',
      }),
    );
    expect(modelChip(container)).toBeNull();
  });

  // bash-task-card + 停止按钮 ---------------------------------------------------
  const stopButton = (container: HTMLElement) =>
    container.querySelector<HTMLButtonElement>('[data-agent-task-stop="true"]');

  it('renders local_bash tasks as a background command with a stop button while running', async () => {
    const stopAgentTask = vi.fn().mockResolvedValue({ ok: true });
    (window as unknown as { electronAPI?: unknown }).electronAPI = {
      maker: { stopAgentTask },
    };
    try {
      const { container } = render(
        React.createElement(AgentTaskCard, {
          sessionId: 'session-1',
          update: {
            provider: 'claude-code',
            taskId: 'bash-1',
            status: 'running',
            title: 'pnpm test:unit',
            taskType: 'local_bash',
          },
        }),
      );
      expect(container.textContent).toContain('chat.agentTask.provider.shell');
      const btn = stopButton(container);
      expect(btn).not.toBeNull();
      // stop 的 finally(setStopping)在微任务里落地,await 到位避免 act 泄漏警告。
      await act(async () => {
        btn!.click();
        await Promise.resolve();
      });
      expect(stopAgentTask).toHaveBeenCalledWith('session-1', 'bash-1');
    } finally {
      delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    }
  });

  it('hides the stop button for terminal tasks, codex tasks, and when sessionId is missing', () => {
    const terminal = render(
      React.createElement(AgentTaskCard, {
        sessionId: 'session-1',
        update: {
          provider: 'claude-code',
          taskId: 'bash-1',
          status: 'completed',
          taskType: 'local_bash',
        },
      }),
    );
    expect(stopButton(terminal.container)).toBeNull();

    const codex = render(
      React.createElement(AgentTaskCard, {
        sessionId: 'session-1',
        update: { provider: 'codex', taskId: 'c1', status: 'running' },
      }),
    );
    expect(stopButton(codex.container)).toBeNull();

    const noSession = render(
      React.createElement(AgentTaskCard, {
        update: {
          provider: 'claude-code',
          taskId: 'bash-1',
          status: 'running',
          taskType: 'local_bash',
        },
      }),
    );
    expect(stopButton(noSession.container)).toBeNull();
  });

  // workflow-card:整卡 = 后台任务面板入口 -------------------------------------
  const headerButton = (container: HTMLElement) =>
    container.querySelector<HTMLButtonElement>('button[aria-label="chat.agentTask.openInPanel"]');

  it('opens the background tasks panel focused on the task when a workflow card is clicked', () => {
    openBackgroundTasksTabMock.mockClear();
    const { container } = render(
      withPanelHost(
        'session-1',
        React.createElement(AgentTaskCard, {
          sessionId: 'session-1',
          update: {
            provider: 'claude-code',
            taskId: 'wf-1',
            status: 'running',
            taskType: 'local_workflow',
            workflowName: 'Release pipeline',
          },
        }),
      ),
    );
    const btn = headerButton(container);
    expect(btn).not.toBeNull();
    // workflow 卡不是展开 toggle:无 aria-expanded。
    expect(btn!.hasAttribute('aria-expanded')).toBe(false);
    act(() => {
      btn!.click();
    });
    expect(openBackgroundTasksTabMock).toHaveBeenCalledWith('session-1', { focusTaskId: 'wf-1' });
  });

  it('opens the background tasks panel on the first click from a split pane', () => {
    openBackgroundTasksTabMock.mockClear();
    const { container } = render(
      withPanelHost(
        'session-b',
        React.createElement(AgentTaskCard, {
          sessionId: 'session-b',
          update: {
            provider: 'claude-code',
            taskId: 'wf-split',
            status: 'running',
            taskType: 'local_workflow',
            workflowName: 'Split workflow',
          },
        }),
        'split-pane',
      ),
    );

    const btn = headerButton(container);
    expect(btn).not.toBeNull();
    expect(btn!.hasAttribute('aria-expanded')).toBe(false);
    act(() => {
      btn!.click();
    });
    expect(openBackgroundTasksTabMock).toHaveBeenCalledWith('session-b', {
      focusTaskId: 'wf-split',
    });
  });

  it('falls back to the expand toggle when sessionId or taskId is missing on a workflow card', () => {
    // 历史重载 workflow 卡(无 live taskId / sessionId):面板侧无该任务数据,
    // 入口模式退回传统展开交互,description/summary 仍就地可读,不做假入口。
    openBackgroundTasksTabMock.mockClear();
    const { container } = render(
      React.createElement(AgentTaskCard, {
        // sessionId 缺失 → 不是面板入口,而是可展开卡。
        update: {
          provider: 'claude-code',
          taskId: 'wf-1',
          status: 'completed',
          taskType: 'local_workflow',
          summary: 'WORKFLOW_HISTORY_SUMMARY',
        },
      }),
    );
    // 无面板入口按钮,但有展开 toggle(aria-expanded 存在)。
    expect(headerButton(container)).toBeNull();
    const toggleBtn = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    expect(toggleBtn).not.toBeNull();
    act(() => {
      toggleBtn!.click();
    });
    expect(openBackgroundTasksTabMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('WORKFLOW_HISTORY_SUMMARY');
  });

  it('corrects a restored workflow card to the file terminal status (failed not painted green)', async () => {
    // tool_result 只是启动回执(失败也存在):历史卡不得据此断言 completed,
    // 与面板列表行同源读 wf 文件终态修正。
    getWorkflowProgressForMock.mockResolvedValueOnce({
      runId: 'wf_hist1',
      status: 'failed',
      phases: [],
      agents: [],
    });
    const { container } = render(
      React.createElement(AgentTaskCard, {
        sessionId: 'session-1',
        toolCall: {
          clientId: 'wf-hist-1',
          role: 'tool_use',
          content: '',
          toolUseId: 'tu-wf-hist',
          toolName: 'Workflow',
          toolInput: {},
        },
        result: 'Workflow launched in background. Task ID: wf_hist1',
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(getWorkflowProgressForMock).toHaveBeenCalledWith('session-1', 'wf_hist1');
    expect(container.textContent).toContain('chat.agentTask.status.failed');
  });

  it('recovers the panel-entry task id from the tool result on history reload', () => {
    // 重载后 update 清空,但持久化 tool_result 里有 CLI 任务 id —— 卡片必须仍是
    // 面板入口(与面板 listSessionTasks 的提取同源,focusTaskId 才配得上)。
    openBackgroundTasksTabMock.mockClear();
    const { container } = render(
      withPanelHost(
        'session-1',
        React.createElement(AgentTaskCard, {
          sessionId: 'session-1',
          toolCall: {
            clientId: 'wf-call-1',
            role: 'tool_use',
            content: '',
            toolUseId: 'tu-wf-1',
            toolName: 'Workflow',
            toolInput: { script: 'export const meta = {}' },
          },
          result: 'Workflow launched in background. Task ID: wf_restored42',
        }),
      ),
    );
    const btn = headerButton(container);
    expect(btn).not.toBeNull();
    act(() => {
      btn!.click();
    });
    expect(openBackgroundTasksTabMock).toHaveBeenCalledWith('session-1', {
      focusTaskId: 'wf_restored42',
    });
  });

  it('renders no inline expand region for workflow cards', () => {
    const { container } = render(
      withPanelHost(
        'session-1',
        React.createElement(AgentTaskCard, {
          sessionId: 'session-1',
          update: {
            provider: 'claude-code',
            taskId: 'wf-1',
            status: 'completed',
            taskType: 'local_workflow',
            workflowName: 'Release pipeline',
            description: 'WORKFLOW_DESCRIPTION_HIDDEN',
            summary: 'WORKFLOW_SUMMARY_HIDDEN',
          },
        }),
      ),
    );
    // useExpandedBlockMemory mock 恒为 expanded=true,仍不得渲染展开区内容。
    expect(container.textContent).not.toContain('WORKFLOW_DESCRIPTION_HIDDEN');
    expect(container.textContent).not.toContain('WORKFLOW_SUMMARY_HIDDEN');
    expect(container.querySelector('[aria-expanded]')).toBeNull();
  });

  it('falls back to the expand toggle in embedded hosts where the panel bucket is invisible', () => {
    // 协同 worker 面板 / workdir-browse 窄 rail:右栏显示的是别的会话(这里 lead),
    // 往本会话 bucket 写 tab 用户看不到 —— 必须退回展开区,不给「点了没反应」的
    // 假入口,也不能因为面板入口化就在这些宿主里彻底没有详情可读。
    openBackgroundTasksTabMock.mockClear();
    const { container } = render(
      withPanelHost(
        'lead-session',
        React.createElement(AgentTaskCard, {
          sessionId: 'worker-session',
          update: {
            provider: 'claude-code',
            taskId: 'wf-1',
            status: 'running',
            taskType: 'local_workflow',
            workflowName: 'Release pipeline',
            summary: 'WORKFLOW_SUMMARY_IN_EMBEDDED_HOST',
          },
        }),
      ),
    );
    expect(headerButton(container)).toBeNull();
    const toggleBtn = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    expect(toggleBtn).not.toBeNull();
    act(() => {
      toggleBtn!.click();
    });
    expect(openBackgroundTasksTabMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('WORKFLOW_SUMMARY_IN_EMBEDDED_HOST');
  });

  const progressLine = (container: HTMLElement) =>
    container.querySelector('[data-workflow-progress-line="true"]');

  it('renders the live progress line from workflowProgress entries', () => {
    const { container } = render(
      React.createElement(AgentTaskCard, {
        sessionId: 'session-1',
        update: {
          provider: 'claude-code',
          taskId: 'wf-1',
          status: 'running',
          taskType: 'local_workflow',
          workflowProgress: [
            { type: 'workflow_phase', index: 0, title: 'Build' },
            { type: 'workflow_agent', index: 1, label: 'a', phaseTitle: 'Build', state: 'done' },
            { type: 'workflow_agent', index: 2, label: 'b', phaseTitle: 'Test', state: 'progress' },
            { type: 'workflow_agent', index: 3, label: 'c', phaseTitle: 'Test', state: 'error' },
          ],
        },
      }),
    );
    expect(progressLine(container)?.textContent).toBe('Test · 2/3 Agent');
  });

  it("counts 'completed' agents as settled in the progress line (visual-state vocab)", () => {
    const { container } = render(
      React.createElement(AgentTaskCard, {
        sessionId: 'session-1',
        update: {
          provider: 'claude-code',
          taskId: 'wf-1',
          status: 'running',
          taskType: 'local_workflow',
          workflowProgress: [
            { type: 'workflow_agent', index: 0, label: 'a', state: 'completed' },
            { type: 'workflow_agent', index: 1, label: 'b', state: 'stopped' },
            { type: 'workflow_agent', index: 2, label: 'c', state: 'start' },
          ],
        },
      }),
    );
    expect(progressLine(container)?.textContent).toBe('2/3 Agent');
  });

  it('falls back to counts only when no running agent carries a phaseTitle', () => {
    const { container } = render(
      React.createElement(AgentTaskCard, {
        sessionId: 'session-1',
        update: {
          provider: 'claude-code',
          taskId: 'wf-1',
          status: 'completed',
          taskType: 'local_workflow',
          workflowProgress: [
            { type: 'workflow_agent', index: 0, label: 'a', state: 'done' },
            { type: 'workflow_agent', index: 1, label: 'b', state: 'done' },
          ],
        },
      }),
    );
    expect(progressLine(container)?.textContent).toBe('2/2 Agent');
  });

  it('renders no progress line when workflowProgress is absent, and keeps non-workflow cards off the panel entry', () => {
    openBackgroundTasksTabMock.mockClear();
    const workflow = render(
      React.createElement(AgentTaskCard, {
        sessionId: 'session-1',
        update: {
          provider: 'claude-code',
          taskId: 'wf-1',
          status: 'running',
          taskType: 'local_workflow',
        },
      }),
    );
    expect(progressLine(workflow.container)).toBeNull();

    const normal = render(
      React.createElement(AgentTaskCard, {
        sessionId: 'session-1',
        update: {
          provider: 'claude-code',
          taskId: 'task-1',
          status: 'running',
          title: 'Inspect files',
        },
      }),
    );
    // 普通卡头部仍是展开 toggle,不触发面板。
    const toggleBtn = normal.container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    expect(toggleBtn).not.toBeNull();
    act(() => {
      toggleBtn!.click();
    });
    expect(openBackgroundTasksTabMock).not.toHaveBeenCalled();
    expect(progressLine(normal.container)).toBeNull();
  });
});
