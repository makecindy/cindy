// @vitest-environment jsdom
//
// 后台命令卡的「仍在运行」证据:运行中每秒刷新的运行时长 + 展开区的命令、开始时间与
// 输出文件末尾(运行中轮询,收起即停)。

import { act, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars && Object.keys(vars).length > 0 ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));

const { expandedState } = vi.hoisted(() => ({ expandedState: { value: true } }));
vi.mock('@/hooks/useExpandedBlockMemory', () => ({
  useExpandedBlockMemory: () => ({ expanded: expandedState.value, setExpanded: vi.fn() }),
}));

const { readTailMock, remoteState } = vi.hoisted(() => ({
  readTailMock: vi.fn(),
  remoteState: { value: false },
}));
vi.mock('@/lib/makerTransport', () => ({
  getWorkflowProgressFor: vi.fn(async () => null),
  isRemoteSessionSticky: () => remoteState.value,
  readBackgroundTaskOutputTailFor: readTailMock,
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

import { AgentTaskCard } from '../AgentTaskCard';
import { formatTaskElapsed, tailOutputLines } from '../AgentTaskLiveDetails';
import type { AgentTaskUpdate, ChatMessage } from '@/hooks/useCCAgentChat';

const START = Date.parse('2026-09-26T10:00:00.000Z');

function bashToolCall(): ChatMessage {
  return {
    clientId: 'c-bash',
    role: 'tool_use',
    content: '',
    toolUseId: 'toolu-bash',
    toolName: 'Bash',
    toolInput: {
      command: 'pnpm test:unit',
      description: 'Run desktop unit tests directly',
      run_in_background: true,
    },
    createdAt: new Date(START).toISOString(),
  } as unknown as ChatMessage;
}

function bashUpdate(overrides: Partial<AgentTaskUpdate> = {}): AgentTaskUpdate {
  return {
    provider: 'claude-code',
    taskId: 'b-1',
    parentToolUseId: 'toolu-bash',
    status: 'running',
    title: 'Run desktop unit tests directly',
    taskType: 'local_bash',
    outputFile: '/private/tmp/claude-501/x/tasks/b-1.output',
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START + 65_000);
  expandedState.value = true;
  remoteState.value = false;
  readTailMock.mockReset();
  readTailMock.mockResolvedValue({
    ok: true,
    text: '\u001b[32m✓\u001b[39m suite a\nprogress 10%\rprogress 90%\n',
    size: 40,
    ageMs: 3_000,
    truncated: false,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentTaskCard background command', () => {
  it('shows a live running duration measured from the launching tool call', async () => {
    const { container } = render(
      <AgentTaskCard sessionId="s-1" toolCall={bashToolCall()} update={bashUpdate()} />,
    );
    await flush();
    const elapsed = () =>
      container.querySelector('[data-agent-task-elapsed="running"]')?.textContent;
    expect(elapsed()).toBe('chat.agentTask.runningFor:{"duration":"1m 05s"}');
    await act(async () => {
      vi.advanceTimersByTime(3_000);
      await Promise.resolve();
    });
    expect(elapsed()).toBe('chat.agentTask.runningFor:{"duration":"1m 08s"}');
  });

  it('shows the command, start time and cleaned recent output when expanded, and keeps polling', async () => {
    const { container } = render(
      <AgentTaskCard sessionId="s-1" toolCall={bashToolCall()} update={bashUpdate()} />,
    );
    await flush();
    const details = container.querySelector('[data-background-command-details="true"]');
    expect(details?.textContent).toContain('pnpm test:unit');
    expect(details?.textContent).toContain('chat.agentTask.startedAt');
    const output = container.querySelector('[data-background-command-output="true"]');
    expect(output?.textContent).toContain('chat.agentTask.recentOutput:{"time":"3s"}');
    expect(output?.querySelector('pre')?.textContent).toBe('✓ suite a\nprogress 90%');
    // 只按 (会话, 任务) 请求,不把输出路径交给主进程。
    expect(readTailMock).toHaveBeenCalledWith('s-1', 'b-1');
    expect(readTailMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
    });
    expect(readTailMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the output age on one clock: host-computed age plus local time since receipt', async () => {
    const { container } = render(
      <AgentTaskCard sessionId="s-1" toolCall={bashToolCall()} update={bashUpdate()} />,
    );
    await flush();
    const label = () =>
      container.querySelector('[data-background-command-output="true"] p')?.textContent;
    expect(label()).toBe('chat.agentTask.recentOutput:{"time":"3s"}');
    // 下一次轮询前本机过了 1 秒:只累加本机经过的时间,不去减被控端的 mtime。
    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(label()).toBe('chat.agentTask.recentOutput:{"time":"4s"}');
  });

  it('anchors a remote session running duration to the local receipt time, not the host clock', async () => {
    remoteState.value = true;
    const { container } = render(
      <AgentTaskCard
        sessionId="s-1"
        // 被控端时钟快了 10 分钟:消息时间比本机当前时间还晚。
        toolCall={{ ...bashToolCall(), createdAt: new Date(START + 665_000).toISOString() }}
        update={bashUpdate({ createdAt: new Date(START + 60_000).toISOString() })}
      />,
    );
    await flush();
    expect(container.querySelector('[data-agent-task-elapsed="running"]')?.textContent).toBe(
      'chat.agentTask.runningFor:{"duration":"5s"}',
    );
  });

  it('does not read the output while collapsed', async () => {
    expandedState.value = false;
    render(<AgentTaskCard sessionId="s-1" toolCall={bashToolCall()} update={bashUpdate()} />);
    await flush();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(readTailMock).not.toHaveBeenCalled();
  });

  it('shows the total duration once finished and stops reading the output', async () => {
    const { container } = render(
      <AgentTaskCard
        sessionId="s-1"
        toolCall={bashToolCall()}
        result="done"
        update={bashUpdate({
          status: 'completed',
          updatedAt: new Date(START + 125_000).toISOString(),
        })}
      />,
    );
    await flush();
    expect(container.querySelector('[data-agent-task-elapsed="running"]')).toBeNull();
    expect(container.textContent).toContain('2m 5s');
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(readTailMock).not.toHaveBeenCalled();
    expect(container.querySelector('[data-background-command-output="true"]')).toBeNull();
    expect(container.textContent).toContain('pnpm test:unit');
  });

  it('hides the output block when the file is not readable on this machine', async () => {
    readTailMock.mockResolvedValue({ ok: false, reason: 'unavailable' });
    const { container } = render(
      <AgentTaskCard sessionId="s-1" toolCall={bashToolCall()} update={bashUpdate()} />,
    );
    await flush();
    expect(container.querySelector('[data-background-command-output="true"]')).toBeNull();
    expect(container.textContent).toContain('pnpm test:unit');
  });
});

describe('background command formatting', () => {
  it('pads elapsed seconds so the running label does not jitter', () => {
    expect(formatTaskElapsed(9_400)).toBe('9s');
    expect(formatTaskElapsed(309_000)).toBe('5m 09s');
    expect(formatTaskElapsed(7_509_000)).toBe('2h 05m 09s');
  });

  it('keeps only the last lines and trims trailing blank lines', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n\n';
    const lines = tailOutputLines(text);
    expect(lines).toHaveLength(12);
    expect(lines[0]).toBe('line 19');
    expect(lines[11]).toBe('line 30');
  });
});
