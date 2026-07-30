import { describe, expect, it } from 'vitest';
import type { AgentEvent, InteractionRequest } from '@cindy/maker-core';
import { DEFAULT_TOOL_ROW_WORDING } from '@cindy/maker-shared/message-presentation';
import { DEFAULT_AGENT_ISLAND_STRINGS } from '../../../shared/agentIsland.js';

import {
  acknowledgeAgentIslandSessionRead,
  applyAgentIslandEvent,
  applyAgentIslandInteractionDismissed,
  applyAgentIslandInteractionRequest,
  applyAgentIslandMetadata,
  applyAgentIslandUserPrompt,
  AGENT_ISLAND_COMPLETION_DWELL_MS,
  AGENT_ISLAND_MESSAGE_PREVIEW_MIN_DWELL_MS,
  AGENT_ISLAND_UNREAD_TRANSIENT_TTL_MS,
  buildAgentIslandDisplayState,
  createAgentIslandState,
  dismissAgentIslandActiveReveal,
  getNextAgentIslandTimerAt,
  markAgentIslandSessionAttention,
  requestAgentIslandManualExpand,
  requestAgentIslandSessionFocus,
  setAgentIslandAppFocused,
  setAgentIslandStrings,
  setAgentIslandToolWording,
  setAgentIslandHovered,
  setAgentIslandLayoutDragActive,
  setAgentIslandPointerZones,
  setAgentIslandVisibleSession,
} from '../state.js';

const REMOTE_DAEMON_CLOSED_REASON = 'remote_daemon_closed';

type PermissionInteractionRequest = Extract<InteractionRequest, { kind: 'permission' }>;

function statusEvent(isRunning: boolean, status: string): AgentEvent {
  return {
    type: 'status',
    source: 'codex',
    data: { isRunning, status },
  };
}

function doneEvent(): AgentEvent {
  return {
    type: 'done',
    source: 'codex',
    data: { result: 'done' },
  };
}

function terminalErrorEvent(message: string, reason?: string): AgentEvent {
  return {
    type: 'error',
    source: 'claude-code',
    data: { message, isTerminal: true, ...(reason ? { reason } : {}) },
  };
}

function finalTextEvent(text: string): AgentEvent {
  return {
    type: 'text',
    source: 'codex',
    data: { text, isFinal: true },
  };
}

function textDeltaEvent(text: string): AgentEvent {
  return {
    type: 'text',
    source: 'codex',
    data: { text, isFinal: false },
  };
}

function toolResultEvent(toolUseId: string): AgentEvent {
  return {
    type: 'tool_result',
    source: 'codex',
    data: { summary: 'Exit 0', toolUseIds: [toolUseId] },
  };
}

function toolUseEvent(toolUseId: string): AgentEvent {
  return {
    type: 'tool_use',
    source: 'codex',
    data: { toolUseId, toolName: 'exec', input: { command: 'pnpm test' } },
  };
}

function permissionRequest(requestId: string): PermissionInteractionRequest {
  return {
    kind: 'permission',
    requestId,
    toolName: 'Bash',
    input: {},
    displayName: 'Run command',
  };
}

function askUserQuestionRequest(requestId: string): InteractionRequest {
  return {
    kind: 'ask_user_question',
    requestId,
    questions: [{ question: 'Continue?', header: 'Question' }],
  };
}

describe('Agent Island display state', () => {
  it('keeps the notch visible even when there are no active sessions', () => {
    const state = createAgentIslandState();

    const display = buildAgentIslandDisplayState(state, 1_000);

    expect(display.visible).toBe(true);
    expect(display.mode).toBe('compact');
    expect(display.notchStatus).toBe('closed');
    expect(display.displayPolicy).toBe('closed');
    expect(display.displaySurface).toBe('collapsed');
    expect(display.layoutMode).toBe('compact');
    expect(display.shadowVisible).toBe(false);
    expect(display.currentSessionId).toBeNull();
    expect(display.totalCount).toBe(0);
    expect(display.pillSnapshot).toEqual({
      priorityId: null,
      priorityStatus: 'idle',
      priorityMicroTitle: '',
      priorityCompactTitle: '',
      sessionCount: 0,
      activeSessionCount: 0,
      pendingInteractionCount: 0,
      unreadCompletedCount: 0,
      deferredRevealCount: 0,
      attentionCount: 0,
    });
  });

  it('shows shadow when the pointer enters the idle notch', () => {
    const state = createAgentIslandState();

    setAgentIslandHovered(state, true, 1_010);
    const display = buildAgentIslandDisplayState(state, 1_020);

    expect(display.mode).toBe('compact');
    expect(display.notchStatus).toBe('closed');
    expect(display.shadowVisible).toBe(true);
    expect(display.currentSessionId).toBeNull();
  });

  it('uses the most recently active running session when all tasks have equal priority', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'a', title: 'A', agentKind: 'codex' }, statusEvent(true, 'Thinking'), 1_000);
    applyAgentIslandEvent(state, { sessionId: 'b', title: 'B', agentKind: 'codex' }, statusEvent(true, 'Running'), 1_100);

    const display = buildAgentIslandDisplayState(state, 1_200);

    expect(display.currentSessionId).toBe('b');
    expect(display.pillSnapshot.priorityId).toBe('b');
    expect(display.pillSnapshot.priorityCompactTitle).toBe('B');
    expect(display.pillSnapshot.activeSessionCount).toBe(2);
    expect(display.sessions.map((session) => session.sessionId)).toEqual(['b', 'a']);
    expect(display.totalCount).toBe(2);
    expect(display.shadowVisible).toBe(false);
  });

  it('uses sidebar-style prompt recency for the compact running session', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'a', title: 'A', agentKind: 'codex' }, statusEvent(true, 'Thinking'), 1_000);
    applyAgentIslandEvent(state, { sessionId: 'b', title: 'B', agentKind: 'codex' }, statusEvent(true, 'Running'), 1_100);

    const firstDisplay = buildAgentIslandDisplayState(state, 1_200);
    expect(firstDisplay.mode).toBe('compact');
    expect(firstDisplay.displaySurface).toBe('collapsed');
    expect(firstDisplay.currentSessionId).toBe('b');
    expect(firstDisplay.pillSnapshot).toMatchObject({
      priorityId: 'b',
      activeSessionCount: 2,
      sessionCount: 2,
    });
    expect(getNextAgentIslandTimerAt(state, 1_200)).toBeNull();

    applyAgentIslandEvent(state, { sessionId: 'a', title: 'A', agentKind: 'codex' }, statusEvent(true, 'Still running'), 4_500);
    const secondDisplay = buildAgentIslandDisplayState(state, 4_550);
    expect(secondDisplay.currentSessionId).toBe('b');
    expect(secondDisplay.pillSnapshot.priorityId).toBe('b');
    expect(secondDisplay.sessions.map((session) => session.sessionId)).toEqual(['b', 'a']);

    applyAgentIslandUserPrompt(state, { sessionId: 'a', title: 'A', agentKind: 'codex' }, 'new task', 6_000);
    const afterUserSend = buildAgentIslandDisplayState(state, 6_050);
    expect(afterUserSend.currentSessionId).toBe('a');
    expect(afterUserSend.pillSnapshot.priorityId).toBe('a');
    expect(afterUserSend.sessions.map((session) => session.sessionId)).toEqual(['a', 'b']);
  });

  it('does not let agent progress reorder same-priority sessions after compact dwell', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'a', title: 'A', agentKind: 'codex' }, statusEvent(true, 'Thinking'), 1_000);
    applyAgentIslandEvent(state, { sessionId: 'b', title: 'B', agentKind: 'codex' }, statusEvent(true, 'Running'), 1_100);

    const firstDisplay = buildAgentIslandDisplayState(state, 1_200);
    expect(firstDisplay.currentSessionId).toBe('b');

    applyAgentIslandEvent(state, { sessionId: 'a', title: 'A', agentKind: 'codex' }, finalTextEvent('Still running'), 4_500);
    applyAgentIslandEvent(state, { sessionId: 'a', title: 'A', agentKind: 'codex' }, toolUseEvent('tool-a'), 4_600);
    const stableDisplay = buildAgentIslandDisplayState(state, 4_700);

    expect(stableDisplay.currentSessionId).toBe('b');
    expect(stableDisplay.sessions.map((session) => session.sessionId)).toEqual(['b', 'a']);
  });

  it('keeps active completion reveals ahead of newer running activity', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'running', title: 'Running', agentKind: 'codex' }, statusEvent(true, 'Thinking'), 1_000);
    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Done', agentKind: 'codex' }, doneEvent(), 1_100);

    const completedDisplay = buildAgentIslandDisplayState(state, 1_150);
    expect(completedDisplay.currentSessionId).toBe('done');
    expect(completedDisplay.displayPolicy).toBe('transient');

    applyAgentIslandEvent(state, { sessionId: 'running', title: 'Running', agentKind: 'codex' }, statusEvent(true, 'Still running'), 1_200);
    const afterRunningUpdate = buildAgentIslandDisplayState(state, 1_250);

    expect(afterRunningUpdate.currentSessionId).toBe('done');
    expect(afterRunningUpdate.sessions.map((session) => session.sessionId)).toEqual(['done']);
  });

  it('builds a CodeIsland-style recent activity preview per session', () => {
    const state = createAgentIslandState();

    applyAgentIslandUserPrompt(
      state,
      { sessionId: 's1', title: 'Draw task', agentKind: 'codex', workingDir: '/repo/xdt-maker' },
      JSON.stringify({ text: '正在执行绘画命令\n请生成一张图', images: [], files: [] }),
      1_000,
    );
    expect(applyAgentIslandEvent(state, { sessionId: 's1' }, textDeltaEvent('partial'), 1_050)).toBe(true);
    applyAgentIslandEvent(state, { sessionId: 's1' }, finalTextEvent('我会开始生成图片。'), 1_100);
    applyAgentIslandEvent(state, {
      sessionId: 's1',
    }, {
      type: 'tool_use',
      source: 'codex',
      data: { toolName: 'imagegen' },
    }, 1_200);

    const display = buildAgentIslandDisplayState(state, 1_250);

    expect(display.sessions[0]).toMatchObject({
      sessionId: 's1',
      projectName: 'xdt-maker',
      detail: 'imagegen',
      activityLines: [
        { id: '1', kind: 'user', text: '正在执行绘画命令 请生成一张图' },
        { id: '2', kind: 'assistant', text: '我会开始生成图片。' },
      ],
      startedAt: 1_000,
    });
  });

  it('updates compact detail while assistant text is still streaming', () => {
    const state = createAgentIslandState();
    const start = 1_000;

    applyAgentIslandUserPrompt(state, { sessionId: 's1', title: 'Task', agentKind: 'codex' }, 'run tests', start);
    applyAgentIslandEvent(state, { sessionId: 's1' }, textDeltaEvent('我会先'), start + 100);
    applyAgentIslandEvent(state, { sessionId: 's1' }, textDeltaEvent('检查日志'), start + 200);

    const streamingDisplay = buildAgentIslandDisplayState(
      state,
      start + AGENT_ISLAND_MESSAGE_PREVIEW_MIN_DWELL_MS + 100,
    );
    expect(streamingDisplay.sessions[0]?.messagePreview?.kind).toBe('assistant');
    expect(streamingDisplay.sessions[0]?.compactDetail).toBe('我会先检查日志');
    expect(streamingDisplay.sessions[0]?.activityLines.map((line) => `${line.kind}:${line.text}`)).toEqual([
      'user:run tests',
      'assistant:我会先检查日志',
    ]);

    applyAgentIslandEvent(state, { sessionId: 's1' }, finalTextEvent('我会先检查日志并继续修复。'), start + 300);
    const finalDisplay = buildAgentIslandDisplayState(
      state,
      start + AGENT_ISLAND_MESSAGE_PREVIEW_MIN_DWELL_MS + 200,
    );
    expect(finalDisplay.sessions[0]?.compactDetail).toBe('我会先检查日志并继续修复。');
    expect(finalDisplay.sessions[0]?.activityLines.map((line) => `${line.kind}:${line.text}`)).toEqual([
      'user:run tests',
      'assistant:我会先检查日志并继续修复。',
    ]);
  });

  it('preserves one assistant stream across a recoverable reconnect error', () => {
    const state = createAgentIslandState();
    const start = 1_000;
    setAgentIslandStrings(state, {
      ...DEFAULT_AGENT_ISLAND_STRINGS,
      networkReconnecting: '（{{attempt}}/{{maxAttempts}}）正在重连…',
    });

    applyAgentIslandUserPrompt(state, { sessionId: 's1', title: 'Task', agentKind: 'codex' }, 'run tests', start);
    applyAgentIslandEvent(state, { sessionId: 's1' }, textDeltaEvent('我会先'), start + 100);
    applyAgentIslandEvent(state, { sessionId: 's1' }, {
      type: 'error',
      source: 'codex',
      data: {
        message: 'Reconnecting... 1/5',
        isTerminal: false,
        willRetry: true,
      },
    }, start + 200);
    expect(state.sessions.get('s1')).toMatchObject({
      assistantStreamRawText: '我会先',
      reconnectStatus: '（1/5）正在重连…',
    });
    expect(buildAgentIslandDisplayState(state, start + 200).sessions[0]).toMatchObject({
      detail: '（1/5）正在重连…',
      compactDetail: '（1/5）正在重连…',
    });

    applyAgentIslandEvent(state, { sessionId: 's1' }, {
      type: 'error',
      source: 'codex',
      data: {
        message: 'Reconnecting... 2/5',
        isTerminal: false,
        willRetry: true,
      },
    }, start + 250);
    expect(buildAgentIslandDisplayState(state, start + 250).sessions[0]).toMatchObject({
      detail: '（2/5）正在重连…',
      compactDetail: '（2/5）正在重连…',
    });

    applyAgentIslandEvent(state, { sessionId: 's1' }, {
      type: 'error',
      source: 'codex',
      data: {
        message: 'Waiting before another automatic retry',
        isTerminal: false,
        willRetry: true,
      },
    }, start + 275);
    expect(state.sessions.get('s1')?.reconnectStatus).toBeNull();
    expect(buildAgentIslandDisplayState(state, start + 275).sessions[0]?.compactDetail)
      .not.toContain('2/5');

    applyAgentIslandEvent(state, { sessionId: 's1' }, textDeltaEvent('继续处理'), start + 300);
    expect(state.sessions.get('s1')?.reconnectStatus).toBeNull();
    applyAgentIslandEvent(
      state,
      { sessionId: 's1' },
      finalTextEvent('我会先继续处理并完成。'),
      start + 400,
    );

    const session = state.sessions.get('s1');
    expect(session).toMatchObject({
      running: true,
      phase: 'running',
      assistantStreamLineId: null,
      assistantStreamRawText: '',
    });
    expect(session?.activityLines.map((line) => `${line.kind}:${line.text}`)).toEqual([
      'user:run tests',
      'assistant:我会先继续处理并完成。',
    ]);
  });

  it('keeps whitespace-only assistant deltas in the raw stream accumulator', () => {
    const state = createAgentIslandState();
    const start = 1_000;

    applyAgentIslandUserPrompt(state, { sessionId: 's1', title: 'Task', agentKind: 'codex' }, 'run tests', start);
    applyAgentIslandEvent(state, { sessionId: 's1' }, textDeltaEvent('\n'), start + 100);

    expect(state.sessions.get('s1')?.assistantStreamRawText).toBe('\n');
    expect(state.sessions.get('s1')?.activityLines.map((line) => `${line.kind}:${line.text}`)).toEqual([
      'user:run tests',
    ]);

    applyAgentIslandEvent(state, { sessionId: 's1' }, textDeltaEvent('我会继续处理'), start + 200);

    expect(state.sessions.get('s1')?.assistantStreamRawText).toBe('\n我会继续处理');
    expect(state.sessions.get('s1')?.activityLines.map((line) => `${line.kind}:${line.text}`)).toEqual([
      'user:run tests',
      'assistant:我会继续处理',
    ]);
  });

  it('lets assistant streaming text take over from a completed tool detail', () => {
    const state = createAgentIslandState();
    const start = 1_000;

    applyAgentIslandEvent(
      state,
      { sessionId: 's1', title: 'Task', agentKind: 'codex' },
      {
        type: 'tool_use',
        source: 'codex',
        data: {
          toolUseId: 'tool-1',
          toolName: 'exec',
          input: { command: 'pnpm test' },
        },
      },
      start,
    );
    applyAgentIslandEvent(state, { sessionId: 's1' }, toolResultEvent('tool-1'), start + 500);
    applyAgentIslandEvent(state, { sessionId: 's1' }, textDeltaEvent('我会继续看输出'), start + 600);

    const afterPreviewDwell = buildAgentIslandDisplayState(
      state,
      start + 600 + AGENT_ISLAND_MESSAGE_PREVIEW_MIN_DWELL_MS + 100,
    );

    expect(afterPreviewDwell.sessions[0]?.detail).toBe('');
    expect(afterPreviewDwell.sessions[0]?.compactDetail).toBe('我会继续看输出');
  });

  it('humanizes intent-classified shell commands with panel wording', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(
      state,
      { sessionId: 's1', title: 'Task', agentKind: 'codex', workingDir: '/repo/xdt-maker' },
      {
        type: 'tool_use',
        source: 'codex',
        data: {
          toolUseId: 'tool-1',
          toolName: 'exec',
          input: { command: 'pnpm --dir apps/desktop test', cwd: '/repo/xdt-maker' },
        },
      },
      1_000,
    );

    const display = buildAgentIslandDisplayState(state, 1_050);

    expect(display.sessions[0]).toMatchObject({
      detail: '运行测试',
      phase: 'running',
    });
  });

  it('keeps the raw shell command when no intent rule classifies it', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(
      state,
      { sessionId: 's1', title: 'Task', agentKind: 'codex', workingDir: '/repo/xdt-maker' },
      {
        type: 'tool_use',
        source: 'codex',
        data: {
          toolUseId: 'tool-1',
          toolName: 'exec',
          // rm 系破坏性命令刻意不进意图规则表:显示原文。
          input: { command: 'rm -rf dist', cwd: '/repo/xdt-maker' },
        },
      },
      1_000,
    );

    expect(buildAgentIslandDisplayState(state, 1_050).sessions[0]?.detail).toBe('$ rm -rf dist');
  });

  it('uses displayCommand for Codex command summaries when raw command is a wrapper', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(
      state,
      { sessionId: 's1', title: 'Task', agentKind: 'codex', workingDir: 'E:\\xdt-maker' },
      {
        type: 'tool_use',
        source: 'codex',
        data: {
          toolUseId: 'tool-1',
          toolName: 'exec',
          input: {
            command:
              '"C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.3.0_x64__8wekyb3d8bbwe\\pwsh.exe" -Command \'pnpm build\'',
            displayCommand: 'pnpm build',
            cwd: 'E:\\xdt-maker',
          },
        },
      },
      1_000,
    );

    const display = buildAgentIslandDisplayState(state, 1_050);

    // displayCommand 解包 wrapper 后作为意图解析输入源:pnpm build → 构建。
    expect(display.sessions[0]?.detail).toBe('构建');
  });

  it('localizes task update tool detail through the injected wording', () => {
    const state = createAgentIslandState();
    setAgentIslandToolWording(state, {
      ...DEFAULT_TOOL_ROW_WORDING,
      verb: (key) => (key === 'updateTodos' ? '正在更新任务' : DEFAULT_TOOL_ROW_WORDING.verb(key)),
    });

    applyAgentIslandEvent(
      state,
      { sessionId: 's1', title: 'Task', agentKind: 'codex' },
      {
        type: 'tool_use',
        source: 'codex',
        data: {
          toolUseId: 'tool-1',
          toolName: 'update_plan',
          input: {},
        },
      },
      1_000,
    );

    const display = buildAgentIslandDisplayState(state, 1_050);

    expect(display.sessions[0]?.detail).toBe('正在更新任务');
  });

  it('lingers then clears a completed tool command like Code Island compact status', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(
      state,
      { sessionId: 's1', title: 'Task', agentKind: 'claude-code' },
      {
        type: 'tool_use',
        source: 'claude-code',
        data: {
          toolUseId: 'tool-1',
          toolName: 'Bash',
          input: { description: 'Run tests', command: 'pnpm test' },
        },
      },
      1_000,
    );
    applyAgentIslandEvent(state, { sessionId: 's1' }, toolResultEvent('tool-1'), 1_500);

    expect(getNextAgentIslandTimerAt(state, 1_600)).toBe(3_500);
    expect(buildAgentIslandDisplayState(state, 2_000).sessions[0]?.detail).toBe('Run tests · $ pnpm test');
    expect(buildAgentIslandDisplayState(state, 3_600).sessions[0]?.detail).toBe('');
  });

  it('keeps compact tool detail during the linger window even if running status updates arrive', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(
      state,
      { sessionId: 's1', title: 'Task', agentKind: 'claude-code' },
      {
        type: 'tool_use',
        source: 'claude-code',
        data: {
          toolUseId: 'tool-1',
          toolName: 'Bash',
          input: { command: 'pnpm test' },
        },
      },
      1_000,
    );
    applyAgentIslandEvent(state, { sessionId: 's1' }, toolResultEvent('tool-1'), 1_500);
    applyAgentIslandEvent(state, { sessionId: 's1' }, statusEvent(true, 'Thinking'), 1_700);

    expect(buildAgentIslandDisplayState(state, 2_000).sessions[0]?.detail).toBe('运行测试');
    expect(buildAgentIslandDisplayState(state, 3_600).sessions[0]?.detail).toBe('');

    applyAgentIslandEvent(state, { sessionId: 's1' }, statusEvent(true, 'Thinking'), 3_700);
    expect(buildAgentIslandDisplayState(state, 3_800).sessions[0]?.detail).toBe('Thinking');
  });

  it('shows the shell command for permission prompts', () => {
    const state = createAgentIslandState();
    applyAgentIslandInteractionRequest(
      state,
      { sessionId: 'ask', title: 'Ask' },
      {
        kind: 'permission',
        requestId: 'r1',
        toolName: 'Bash',
        input: { command: 'rm -rf dist' },
        displayName: 'Run command',
        suggestions: [{ destination: 'session', type: 'addRules' }, { destination: 'project' }],
      },
      1_000,
    );

    const display = buildAgentIslandDisplayState(state, 1_100);

    expect(display.sessions[0]).toMatchObject({
      phase: 'needs-interaction',
      detail: '$ rm -rf dist',
      permissionAction: {
        requestId: 'r1',
        canAllowForSession: true,
      },
    });
  });

  it('omits session approval action when permission suggestions are not session scoped', () => {
    const state = createAgentIslandState();
    applyAgentIslandInteractionRequest(
      state,
      { sessionId: 'ask', title: 'Ask' },
      {
        kind: 'permission',
        requestId: 'r1',
        toolName: 'Bash',
        input: { command: 'pnpm test' },
        suggestions: [{ destination: 'project' }],
      },
      1_000,
    );

    const display = buildAgentIslandDisplayState(state, 1_100);

    expect(display.sessions[0]?.permissionAction).toEqual({
      requestId: 'r1',
      canAllowForSession: false,
    });
  });

  it('keeps a newly sent user prompt collapsed until hover or attention', () => {
    const state = createAgentIslandState();

    applyAgentIslandUserPrompt(state, { sessionId: 's1', title: 'Task', agentKind: 'codex' }, 'run tests', 1_000);
    const display = buildAgentIslandDisplayState(state, 1_050);

    expect(display.mode).toBe('compact');
    expect(display.displayPolicy).toBe('peek');
    expect(display.displaySurface).toBe('collapsed');
    expect(display.shadowVisible).toBe(false);
    expect(display.currentSessionId).toBe('s1');
  });

  it('uses the recent user prompt as compact title when session metadata is missing', () => {
    const state = createAgentIslandState();

    applyAgentIslandUserPrompt(state, { sessionId: 's1', agentKind: 'codex' }, 'run island tests', 1_000);
    const display = buildAgentIslandDisplayState(state, 1_050);

    expect(display.pillSnapshot.priorityCompactTitle).toBe('run island tests');
    expect(display.pillSnapshot.priorityCompactTitle).not.toBe('codex');
  });

  it('哨兵标题不进 pillSnapshot —— meaningfulSessionTitle 先把它过滤掉', () => {
    // review 曾担心 priorityCompactTitle 会把原始哨兵带给 native(Swift 侧的 compactTitle
    // 优先读这个字段)。事实是取值链第一步 meaningfulSessionTitle 就按大小写无关过滤掉
    // 'new maker' / 'untitled' / 'codex' 等泛化串,pill 因此回落到项目名 —— 小尺寸胶囊里
    // 项目名本来也比「未命名对话」有信息量。这条断言把该事实钉住,免得日后有人放宽过滤
    // 又把哨兵漏给 native(PR #1031 review 第 13 轮)。
    const state = createAgentIslandState();

    applyAgentIslandEvent(
      state,
      {
        sessionId: 's1',
        title: 'New Maker',
        agentKind: 'codex',
        workingDir: '/repo/cindy',
      },
      statusEvent(true, 'Thinking'),
      1_000,
    );
    const display = buildAgentIslandDisplayState(state, 1_050);

    expect(display.pillSnapshot.priorityCompactTitle).toBe('cindy');
    expect(display.pillSnapshot.priorityCompactTitle).not.toBe('New Maker');
    expect(display.pillSnapshot.priorityMicroTitle).not.toBe('New Maker');
  });

  it('prefers a bounded conversation title over the project name for the compact title', () => {
    const state = createAgentIslandState();

    applyAgentIslandEvent(
      state,
      {
        sessionId: 's1',
        title: 'abcdefghijklmnopqrstuvwxyz1234567890',
        agentKind: 'codex',
        workingDir: '/repo/xdt-maker',
      },
      statusEvent(true, 'Thinking'),
      1_000,
    );
    const display = buildAgentIslandDisplayState(state, 1_050);

    expect(display.pillSnapshot.priorityCompactTitle).toBe('abcdefghijklmnopqrstuvwxy...');
    expect(display.pillSnapshot.priorityCompactTitle).not.toBe('xdt-maker');
  });

  it('uses the latest assistant text as compact detail when no stronger status detail exists', () => {
    const state = createAgentIslandState();

    applyAgentIslandUserPrompt(state, { sessionId: 's1', title: 'Task', agentKind: 'codex' }, 'run tests', 1_000);
    applyAgentIslandEvent(state, { sessionId: 's1' }, finalTextEvent('我已经完成了第一步，并且正在继续处理后续内容。'), 1_100);
    const display = buildAgentIslandDisplayState(state, 1_000 + AGENT_ISLAND_MESSAGE_PREVIEW_MIN_DWELL_MS + 100);

    expect(display.sessions[0]?.detail).toBe('');
    expect(display.sessions[0]?.compactDetail).toBe('我已经完成了第一步，并且正在继续处理后续内容。');
  });

  it('keeps generic running status behind assistant text in compact detail', () => {
    const state = createAgentIslandState();

    applyAgentIslandUserPrompt(state, { sessionId: 's1', title: 'Task', agentKind: 'codex' }, 'run tests', 1_000);
    applyAgentIslandEvent(state, { sessionId: 's1' }, finalTextEvent('我会先检查测试失败原因。'), 1_100);
    applyAgentIslandEvent(state, { sessionId: 's1' }, statusEvent(true, 'Generating...'), 1_200);
    const display = buildAgentIslandDisplayState(state, 1_000 + AGENT_ISLAND_MESSAGE_PREVIEW_MIN_DWELL_MS + 100);

    expect(display.sessions[0]?.detail).toBe('Generating...');
    expect(display.sessions[0]?.compactDetail).toBe('我会先检查测试失败原因。');
  });

  it('uses the user prompt before generic running status when no assistant text exists', () => {
    const state = createAgentIslandState();

    applyAgentIslandUserPrompt(state, { sessionId: 's1', title: 'Task', agentKind: 'codex' }, 'run island tests', 1_000);
    applyAgentIslandEvent(state, { sessionId: 's1' }, statusEvent(true, 'Thinking'), 1_100);
    const display = buildAgentIslandDisplayState(state, 1_150);

    expect(display.sessions[0]?.detail).toBe('Thinking');
    expect(display.sessions[0]?.compactDetail).toBe('run island tests');
  });

  it('shows each user and assistant message for a minimum dwell before tool details take over', () => {
    const state = createAgentIslandState();
    const start = 1_000;

    applyAgentIslandUserPrompt(state, { sessionId: 's1', title: 'Task', agentKind: 'codex' }, 'run island tests', start);
    applyAgentIslandEvent(state, { sessionId: 's1' }, finalTextEvent('我会先检查测试失败原因。'), start + 100);
    applyAgentIslandEvent(
      state,
      { sessionId: 's1' },
      {
        type: 'tool_use',
        source: 'codex',
        data: {
          toolUseId: 'tool-1',
          toolName: 'exec',
          input: { command: 'pnpm test' },
        },
      },
      start + 200,
    );

    const whileUserMessageDwells = buildAgentIslandDisplayState(state, start + 300);
    expect(whileUserMessageDwells.sessions[0]?.messagePreview?.kind).toBe('user');
    expect(whileUserMessageDwells.sessions[0]?.compactDetail).toBe('run island tests');

    const afterUserDwell = buildAgentIslandDisplayState(
      state,
      start + AGENT_ISLAND_MESSAGE_PREVIEW_MIN_DWELL_MS + 100,
    );
    expect(afterUserDwell.sessions[0]?.messagePreview?.kind).toBe('assistant');
    expect(afterUserDwell.sessions[0]?.compactDetail).toBe('我会先检查测试失败原因。');

    const afterAssistantDwell = buildAgentIslandDisplayState(
      state,
      start + AGENT_ISLAND_MESSAGE_PREVIEW_MIN_DWELL_MS * 2 + 200,
    );
    expect(afterAssistantDwell.sessions[0]?.messagePreview).toBeNull();
    expect(afterAssistantDwell.sessions[0]?.compactDetail).toBe('运行测试');
  });

  it('does not display managed dialogue workspace folders as projects', () => {
    const state = createAgentIslandState();

    applyAgentIslandUserPrompt(
      state,
      {
        sessionId: 's1',
        agentKind: 'codex',
        workingDir: '/Users/alice/Library/Application Support/xdt-maker/dialogues/2026-06-16/14ad7035-b7aa-4f5d-bc9f-6e39cffdd9ea',
        workspaceKind: 'dialogue',
      },
      '/goal 测试一下是不是支持目标模式',
      1_000,
    );
    applyAgentIslandMetadata(state, {
      sessionId: 's1',
      title: '目标模式测试',
      workingDir: '/Users/alice/Library/Application Support/xdt-maker/dialogues/2026-06-16/14ad7035-b7aa-4f5d-bc9f-6e39cffdd9ea',
      workspaceKind: 'dialogue',
    }, 1_100);

    const display = buildAgentIslandDisplayState(state, 1_150);

    expect(display.sessions[0]).toMatchObject({
      title: '目标模式测试',
      projectName: null,
    });
    expect(display.pillSnapshot.priorityCompactTitle).toBe('目标模式测试');
  });

  it('keeps only the latest three activity preview lines', () => {
    const state = createAgentIslandState();

    applyAgentIslandUserPrompt(state, { sessionId: 's1' }, 'first', 1_000);
    applyAgentIslandEvent(state, { sessionId: 's1' }, finalTextEvent('first answer'), 1_100);
    applyAgentIslandUserPrompt(state, { sessionId: 's1' }, 'second', 1_200);
    applyAgentIslandEvent(state, { sessionId: 's1' }, finalTextEvent('second answer'), 1_300);

    const display = buildAgentIslandDisplayState(state, 1_400);

    expect(display.sessions[0]?.activityLines.map((line) => `${line.kind}:${line.text}`)).toEqual([
      'assistant:first answer',
      'user:second',
      'assistant:second answer',
    ]);
  });

  it('prioritizes interaction, terminal error, completion, then running sessions', () => {
    const state = createAgentIslandState();
    // Deliberately create the lower-priority states later: phase priority must
    // win before the sidebar-style prompt/fallback time is considered.
    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask' }, permissionRequest('r1'), 1_000);
    applyAgentIslandEvent(state, { sessionId: 'error', title: 'Error' }, terminalErrorEvent('failed'), 1_100);
    applyAgentIslandEvent(state, { sessionId: 'completed', title: 'Completed' }, doneEvent(), 1_200);
    applyAgentIslandEvent(state, { sessionId: 'running', title: 'Running' }, statusEvent(true, 'Generating'), 1_300);

    const display = buildAgentIslandDisplayState(state, 1_400);

    expect(display.currentSessionId).toBe('ask');
    expect(display.pillSnapshot).toMatchObject({
      priorityId: 'ask',
      priorityStatus: 'needs-interaction',
      activeSessionCount: 2,
      pendingInteractionCount: 1,
      unreadCompletedCount: 2,
      sessionCount: 4,
    });
    expect(display.shadowVisible).toBe(true);
    expect(display.sessions.map((session) => session.sessionId)).toEqual([
      'ask',
      'error',
      'completed',
      'running',
    ]);
  });

  it('keeps visible-session completion compact without creating unread attention', () => {
    const state = createAgentIslandState();
    setAgentIslandVisibleSession(state, 'done', 1_900);
    setAgentIslandAppFocused(state, true, 1_950);

    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Done' }, doneEvent(), 2_000);

    const display = buildAgentIslandDisplayState(state, 2_100);

    expect(display.visible).toBe(true);
    expect(display.mode).toBe('compact');
    expect(display.smartSuppressed).toBe(false);
    expect(display.shadowVisible).toBe(false);
    expect(display.currentSessionId).toBe('done');
    expect(display.pillSnapshot.deferredRevealCount).toBe(0);
    expect(display.pillSnapshot.unreadCompletedCount).toBe(0);
  });

  it('localizes completion placeholder activity text', () => {
    const state = createAgentIslandState();
    setAgentIslandStrings(state, {
      ...DEFAULT_AGENT_ISLAND_STRINGS,
      done: '完成',
    });

    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Done' }, doneEvent(), 2_000);

    const display = buildAgentIslandDisplayState(state, 2_100);

    expect(display.sessions[0]?.activityLines.at(-1)?.text).toBe('完成');
  });

  it('does not reveal or retain a silenced scheduler completion', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Done' }, statusEvent(true, 'Running'), 1_000);

    applyAgentIslandEvent(
      state,
      { sessionId: 'done', title: 'Done' },
      doneEvent(),
      2_000,
      { suppressCompletionAttention: true },
    );

    const display = buildAgentIslandDisplayState(state, 2_100);

    expect(display.mode).toBe('compact');
    expect(display.displayPolicy).toBe('closed');
    expect(display.currentSessionId).toBeNull();
    expect(display.totalCount).toBe(0);
    expect(display.pillSnapshot.unreadCompletedCount).toBe(0);
  });

  it('does not reveal a silenced status Done event', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Done' }, statusEvent(true, 'Running'), 1_000);

    applyAgentIslandEvent(
      state,
      { sessionId: 'done', title: 'Done' },
      statusEvent(false, 'Done'),
      2_000,
      { suppressCompletionAttention: true },
    );

    const display = buildAgentIslandDisplayState(state, 2_100);

    expect(display.displayPolicy).toBe('closed');
    expect(display.totalCount).toBe(0);
  });

  it('does not resurrect visible-session completion after the main window leaves the foreground', () => {
    const state = createAgentIslandState();
    setAgentIslandVisibleSession(state, 'done', 1_900);
    setAgentIslandAppFocused(state, true, 2_000);
    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Done' }, doneEvent(), 2_100);

    setAgentIslandAppFocused(state, false, 2_500);
    const display = buildAgentIslandDisplayState(state, 2_600);

    expect(display.mode).toBe('compact');
    expect(display.displayPolicy).toBe('transient');
    expect(display.smartSuppressed).toBe(false);
    expect(display.shadowVisible).toBe(false);
    expect(display.pillSnapshot.deferredRevealCount).toBe(0);
    expect(display.pillSnapshot.unreadCompletedCount).toBe(0);
  });

  it('expands on hover for a visible-session completion without adding unread attention', () => {
    const state = createAgentIslandState();
    setAgentIslandVisibleSession(state, 'done', 1_900);
    setAgentIslandAppFocused(state, true, 1_950);
    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Done' }, doneEvent(), 2_000);

    setAgentIslandHovered(state, true, 2_100);
    const display = buildAgentIslandDisplayState(state, 2_650);

    expect(display.mode).toBe('expanded');
    expect(display.notchStatus).toBe('expanded');
    expect(display.displayPolicy).toBe('manualExpanded');
    expect(display.displaySurface).toBe('sessionList');
    expect(display.layoutMode).toBe('normal');
    expect(display.pillSnapshot.unreadCompletedCount).toBe(0);
  });

  it('mirrors the app attention dot for completed sessions', () => {
    const state = createAgentIslandState();
    setAgentIslandVisibleSession(state, 'done', 1_900);
    setAgentIslandAppFocused(state, true, 1_950);
    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Done' }, doneEvent(), 2_000);
    expect(buildAgentIslandDisplayState(state, 2_100).pillSnapshot.unreadCompletedCount).toBe(0);

    expect(markAgentIslandSessionAttention(state, 'done')).toBe(true);
    const unreadDisplay = buildAgentIslandDisplayState(state, 2_150);
    expect(unreadDisplay.pillSnapshot.unreadCompletedCount).toBe(1);
    expect(unreadDisplay.sessions[0]).toMatchObject({
      sessionId: 'done',
      attention: true,
    });

    expect(acknowledgeAgentIslandSessionRead(state, 'done', 8_000)).toBe('cleared');
    const clearedDisplay = buildAgentIslandDisplayState(state, 8_100);
    expect(clearedDisplay.pillSnapshot.unreadCompletedCount).toBe(0);
    expect(clearedDisplay.currentSessionId).toBeNull();
  });

  it('still expands a different session completion while the visible session is focused', () => {
    const state = createAgentIslandState();
    setAgentIslandVisibleSession(state, 'visible', 1_000);
    setAgentIslandAppFocused(state, true, 1_000);

    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Done' }, doneEvent(), 1_100);

    const display = buildAgentIslandDisplayState(state, 1_150);

    expect(display.mode).toBe('expanded');
    expect(display.displayPolicy).toBe('transient');
    expect(display.displaySurface).toBe('completionCard');
    expect(display.smartSuppressed).toBe(false);
    expect(display.currentSessionId).toBe('done');
  });

  it('queues completion reveals instead of letting a newer completion replace the active card', () => {
    const state = createAgentIslandState();

    applyAgentIslandEvent(state, { sessionId: 'first', title: 'First' }, doneEvent(), 1_000);
    applyAgentIslandEvent(state, { sessionId: 'second', title: 'Second' }, doneEvent(), 1_100);

    const firstDisplay = buildAgentIslandDisplayState(state, 1_200);
    expect(firstDisplay.mode).toBe('expanded');
    expect(firstDisplay.displayPolicy).toBe('transient');
    expect(firstDisplay.currentSessionId).toBe('first');
    expect(firstDisplay.pillSnapshot.deferredRevealCount).toBe(1);

    const stillFirstDisplay = buildAgentIslandDisplayState(state, 6_100);
    expect(stillFirstDisplay.mode).toBe('expanded');
    expect(stillFirstDisplay.displayPolicy).toBe('transient');
    expect(stillFirstDisplay.currentSessionId).toBe('first');

    const secondDisplay = buildAgentIslandDisplayState(state, 13_100);
    expect(secondDisplay.mode).toBe('expanded');
    expect(secondDisplay.displayPolicy).toBe('transient');
    expect(secondDisplay.currentSessionId).toBe('second');
    expect(secondDisplay.sessions.map((session) => session.sessionId)).toEqual(['second', 'first']);
  });

  it('keeps blocking interaction cards ahead of queued completion reveals', () => {
    const state = createAgentIslandState();

    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Done' }, doneEvent(), 1_000);
    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask' }, permissionRequest('r1'), 1_100);

    const blocked = buildAgentIslandDisplayState(state, 1_200);
    expect(blocked.mode).toBe('expanded');
    expect(blocked.displayPolicy).toBe('blocking');
    expect(blocked.displaySurface).toBe('interactionCard');
    expect(blocked.currentSessionId).toBe('ask');
    expect(blocked.sessions.map((session) => session.sessionId)).toEqual(['ask', 'done']);
    expect(blocked.pillSnapshot.deferredRevealCount).toBe(1);

    expect(dismissAgentIslandActiveReveal(state, 2_300)).toBe(true);
    const collapsed = buildAgentIslandDisplayState(state, 2_350);
    expect(collapsed.mode).toBe('compact');
    expect(collapsed.displayPolicy).toBe('blocking');

    applyAgentIslandInteractionDismissed(state, 'ask', 'r1', 2_400);
    const resumed = buildAgentIslandDisplayState(state, 2_450);
    expect(resumed.mode).toBe('expanded');
    expect(resumed.displayPolicy).toBe('transient');
    expect(resumed.currentSessionId).toBe('done');
  });

  it('resumes queued completion reveals after a dismissed interaction becomes hidden in the visible session', () => {
    const state = createAgentIslandState();

    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Done' }, doneEvent(), 1_000);
    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask' }, askUserQuestionRequest('r1'), 1_100);

    const blocked = buildAgentIslandDisplayState(state, 1_200);
    expect(blocked.mode).toBe('expanded');
    expect(blocked.displayPolicy).toBe('blocking');
    expect(blocked.displaySurface).toBe('interactionCard');
    expect(blocked.currentSessionId).toBe('ask');

    expect(dismissAgentIslandActiveReveal(state, 2_300)).toBe(true);
    const collapsed = buildAgentIslandDisplayState(state, 2_350);
    expect(collapsed.mode).toBe('compact');
    expect(collapsed.displayPolicy).toBe('blocking');

    setAgentIslandAppFocused(state, true, 2_400);
    setAgentIslandVisibleSession(state, 'ask', 2_400);

    const stillWaiting = buildAgentIslandDisplayState(state, 2_450);
    expect(stillWaiting.mode).toBe('compact');
    expect(stillWaiting.displayPolicy).toBe('blocking');
    expect(stillWaiting.currentSessionId).toBe('ask');

    const resumed = buildAgentIslandDisplayState(state, 2_400 + AGENT_ISLAND_COMPLETION_DWELL_MS + 100);
    expect(resumed.mode).toBe('expanded');
    expect(resumed.displayPolicy).toBe('transient');
    expect(resumed.displaySurface).toBe('completionCard');
    expect(resumed.currentSessionId).toBe('done');
  });

  it('keeps interaction reminders on their card when the pointer hovers the expanded panel', () => {
    const state = createAgentIslandState();
    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask' }, permissionRequest('r1'), 1_000);

    const reminder = buildAgentIslandDisplayState(state, 1_100);
    expect(reminder.mode).toBe('expanded');
    expect(reminder.displayPolicy).toBe('blocking');
    expect(reminder.displaySurface).toBe('interactionCard');

    setAgentIslandPointerZones(state, { menuBar: false, panel: true }, 1_150);
    const hovered = buildAgentIslandDisplayState(state, 1_800);

    expect(hovered.mode).toBe('expanded');
    expect(hovered.displayPolicy).toBe('blocking');
    expect(hovered.displaySurface).toBe('interactionCard');
    expect(hovered.currentSessionId).toBe('ask');
  });

  it('keeps visible-session ask-user prompts compact and smart-suppressed', () => {
    const state = createAgentIslandState();
    setAgentIslandVisibleSession(state, 'ask', 900);
    setAgentIslandAppFocused(state, true, 950);

    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask' }, askUserQuestionRequest('r1'), 1_000);

    const display = buildAgentIslandDisplayState(state, 1_100);
    expect(display.mode).toBe('compact');
    expect(display.displayPolicy).toBe('blocking');
    expect(display.displaySurface).toBe('collapsed');
    expect(display.smartSuppressed).toBe(true);
    expect(display.currentSessionId).toBe('ask');
    expect(display.sessions[0]).toMatchObject({
      sessionId: 'ask',
      phase: 'needs-interaction',
      attention: true,
    });
  });

  it('expands visible-session permission prompts so users can approve in the island', () => {
    const state = createAgentIslandState();
    setAgentIslandVisibleSession(state, 'ask', 900);
    setAgentIslandAppFocused(state, true, 950);

    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask' }, permissionRequest('r1'), 1_000);

    const display = buildAgentIslandDisplayState(state, 1_100);
    expect(display.mode).toBe('expanded');
    expect(display.displayPolicy).toBe('blocking');
    expect(display.displaySurface).toBe('interactionCard');
    expect(display.smartSuppressed).toBe(false);
    expect(display.currentSessionId).toBe('ask');
    expect(display.sessions[0]).toMatchObject({
      sessionId: 'ask',
      phase: 'needs-interaction',
      permissionAction: {
        requestId: 'r1',
        canAllowForSession: false,
      },
    });
  });

  it('keeps pending interactions expanded until the request is dismissed', () => {
    const state = createAgentIslandState();

    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask' }, permissionRequest('r1'), 1_000);

    const display = buildAgentIslandDisplayState(state, 20_000);

    expect(display.mode).toBe('expanded');
    expect(display.displayPolicy).toBe('blocking');
    expect(display.displaySurface).toBe('interactionCard');
    expect(display.currentSessionId).toBe('ask');
  });

  it('protects interaction reminders briefly before outside click can collapse them', () => {
    const state = createAgentIslandState();
    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask' }, permissionRequest('r1'), 1_000);
    expect(buildAgentIslandDisplayState(state, 1_100).mode).toBe('expanded');

    expect(dismissAgentIslandActiveReveal(state, 1_200)).toBe(false);
    const protectedDisplay = buildAgentIslandDisplayState(state, 1_250);
    expect(protectedDisplay.mode).toBe('expanded');
    expect(protectedDisplay.displaySurface).toBe('interactionCard');

    expect(dismissAgentIslandActiveReveal(state, 2_200)).toBe(true);
    const display = buildAgentIslandDisplayState(state, 2_250);

    expect(display.mode).toBe('compact');
    expect(display.displayPolicy).toBe('blocking');
    expect(display.displaySurface).toBe('collapsed');
    expect(display.currentSessionId).toBe('ask');
    expect(display.pillSnapshot.pendingInteractionCount).toBe(1);
    expect(display.sessions[0]).toMatchObject({
      sessionId: 'ask',
      phase: 'needs-interaction',
      attention: true,
    });
  });

  it('refreshes outside-click protection when an interaction replaces an expanded completion card', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Done' }, doneEvent(), 1_000);

    const completion = buildAgentIslandDisplayState(state, 1_100);
    expect(completion.mode).toBe('expanded');
    expect(completion.displayPolicy).toBe('transient');
    expect(completion.displaySurface).toBe('completionCard');
    expect(completion.currentSessionId).toBe('done');

    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask' }, permissionRequest('r1'), 2_200);
    const interaction = buildAgentIslandDisplayState(state, 2_250);
    expect(interaction.mode).toBe('expanded');
    expect(interaction.displayPolicy).toBe('blocking');
    expect(interaction.displaySurface).toBe('interactionCard');
    expect(interaction.currentSessionId).toBe('ask');

    expect(dismissAgentIslandActiveReveal(state, 2_300)).toBe(false);
    const protectedDisplay = buildAgentIslandDisplayState(state, 2_350);
    expect(protectedDisplay.mode).toBe('expanded');
    expect(protectedDisplay.displaySurface).toBe('interactionCard');
    expect(protectedDisplay.currentSessionId).toBe('ask');

    expect(dismissAgentIslandActiveReveal(state, 3_300)).toBe(true);
    const dismissed = buildAgentIslandDisplayState(state, 3_350);
    expect(dismissed.mode).toBe('compact');
    expect(dismissed.displayPolicy).toBe('blocking');
    expect(dismissed.currentSessionId).toBe('ask');
  });

  it('keeps a manually collapsed permission card stable when another permission queues behind it', () => {
    const state = createAgentIslandState();
    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask' }, permissionRequest('r1'), 1_000);
    buildAgentIslandDisplayState(state, 1_100);
    expect(dismissAgentIslandActiveReveal(state, 2_200)).toBe(true);
    expect(buildAgentIslandDisplayState(state, 2_250).mode).toBe('compact');

    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask' }, permissionRequest('r2'), 2_300);
    const display = buildAgentIslandDisplayState(state, 2_400);

    expect(display.mode).toBe('compact');
    expect(display.displayPolicy).toBe('blocking');
    expect(display.displaySurface).toBe('collapsed');
    expect(display.currentSessionId).toBe('ask');
    expect(display.sessions[0]?.permissionAction).toMatchObject({ requestId: 'r1' });
  });

  it('keeps a manually collapsed pending interaction collapsed across running updates', () => {
    const state = createAgentIslandState();
    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask' }, permissionRequest('r1'), 1_000);
    buildAgentIslandDisplayState(state, 1_100);
    expect(dismissAgentIslandActiveReveal(state, 2_200)).toBe(true);

    applyAgentIslandEvent(state, { sessionId: 'ask', title: 'Ask' }, statusEvent(true, 'Working'), 2_300);
    let display = buildAgentIslandDisplayState(state, 2_350);

    expect(display.mode).toBe('compact');
    expect(display.displayPolicy).toBe('blocking');
    expect(display.displaySurface).toBe('collapsed');
    expect(display.currentSessionId).toBe('ask');

    applyAgentIslandEvent(
      state,
      { sessionId: 'ask', title: 'Ask' },
      {
        type: 'tool_use',
        source: 'codex',
        data: { toolUseId: 'tool-1', toolName: 'exec', input: { command: 'pnpm test' } },
      },
      2_400,
    );
    display = buildAgentIslandDisplayState(state, 2_450);

    expect(display.mode).toBe('compact');
    expect(display.displayPolicy).toBe('blocking');
    expect(display.displaySurface).toBe('collapsed');
    expect(display.currentSessionId).toBe('ask');
  });

  it('clears a permission prompt when a Claude Code tool_use starts with a matching id', () => {
    const state = createAgentIslandState();
    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask' }, permissionRequest('toolu_claude_123'), 1_000);

    applyAgentIslandEvent(
      state,
      { sessionId: 'ask', title: 'Ask' },
      {
        type: 'tool_use',
        source: 'claude-code',
        data: { id: 'toolu_claude_123', name: 'Bash', input: { command: 'pnpm test' } },
      },
      1_100,
    );

    const display = buildAgentIslandDisplayState(state, 1_150);
    expect(display.sessions[0]).toMatchObject({
      phase: 'running',
      permissionAction: null,
    });
  });

  it('dismisses only the visible interaction card when multiple sessions are pending', () => {
    const state = createAgentIslandState();
    applyAgentIslandInteractionRequest(state, { sessionId: 'older', title: 'Older' }, permissionRequest('r1'), 1_000);
    applyAgentIslandInteractionRequest(state, { sessionId: 'newer', title: 'Newer' }, permissionRequest('r2'), 1_100);

    const firstDisplay = buildAgentIslandDisplayState(state, 1_200);
    expect(firstDisplay.mode).toBe('expanded');
    expect(firstDisplay.currentSessionId).toBe('newer');

    expect(dismissAgentIslandActiveReveal(state, 2_300)).toBe(true);
    const collapsed = buildAgentIslandDisplayState(state, 2_350);
    expect(collapsed.mode).toBe('compact');
    expect(collapsed.pillSnapshot.pendingInteractionCount).toBe(2);

    expect(dismissAgentIslandActiveReveal(state, 2_360)).toBe(false);
    expect(buildAgentIslandDisplayState(state, 2_370).mode).toBe('compact');

    applyAgentIslandInteractionDismissed(state, 'newer', 'r2', 2_400);
    const restoredOlder = buildAgentIslandDisplayState(state, 2_450);

    expect(restoredOlder.mode).toBe('expanded');
    expect(restoredOlder.displayPolicy).toBe('blocking');
    expect(restoredOlder.displaySurface).toBe('interactionCard');
    expect(restoredOlder.currentSessionId).toBe('older');
  });

  it('keeps completion reminders on their card when the pointer hovers the expanded panel', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'running', title: 'Running' }, statusEvent(true, 'Working'), 1_000);
    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Done' }, doneEvent(), 2_000);

    const reminder = buildAgentIslandDisplayState(state, 2_100);
    expect(reminder.mode).toBe('expanded');
    expect(reminder.displayPolicy).toBe('transient');
    expect(reminder.displaySurface).toBe('completionCard');
    expect(reminder.sessions.map((session) => session.sessionId)).toEqual(['done']);

    setAgentIslandPointerZones(state, { menuBar: false, panel: true }, 2_150);
    const hovered = buildAgentIslandDisplayState(state, 2_800);

    expect(hovered.mode).toBe('expanded');
    expect(hovered.displayPolicy).toBe('transient');
    expect(hovered.displaySurface).toBe('completionCard');
    expect(hovered.sessions.map((session) => session.sessionId)).toEqual(['done']);
  });

  it('does not arm hover expansion while a completion reminder is visible', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Done' }, doneEvent(), 2_000);

    setAgentIslandHovered(state, true, 2_100);
    const hovered = buildAgentIslandDisplayState(state, 2_800);

    expect(hovered.mode).toBe('expanded');
    expect(hovered.displayPolicy).toBe('transient');
    expect(hovered.displaySurface).toBe('completionCard');
    expect(getNextAgentIslandTimerAt(state, 2_800)).not.toBe(2_600);
  });

  it('auto-hides an already expanded interaction once the user views its session', () => {
    const state = createAgentIslandState();
    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask' }, askUserQuestionRequest('r1'), 1_000);
    expect(buildAgentIslandDisplayState(state, 1_100).mode).toBe('expanded');

    setAgentIslandAppFocused(state, true, 1_200);
    setAgentIslandVisibleSession(state, 'ask', 1_200);
    const suppressed = buildAgentIslandDisplayState(state, 1_300);
    expect(suppressed.mode).toBe('compact');
    expect(suppressed.displayPolicy).toBe('blocking');
    expect(suppressed.smartSuppressed).toBe(true);
    expect(suppressed.totalCount).toBe(1);
    expect(getNextAgentIslandTimerAt(state, 1_300)).toBe(1_200 + AGENT_ISLAND_COMPLETION_DWELL_MS);

    const hidden = buildAgentIslandDisplayState(state, 1_200 + AGENT_ISLAND_COMPLETION_DWELL_MS + 1);
    expect(hidden.displayPolicy).toBe('closed');
    expect(hidden.totalCount).toBe(0);
  });

  it('restores a hidden pending interaction when the user leaves the session before answering', () => {
    const state = createAgentIslandState();
    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask' }, askUserQuestionRequest('r1'), 1_000);
    setAgentIslandAppFocused(state, true, 1_200);
    setAgentIslandVisibleSession(state, 'ask', 1_200);
    expect(buildAgentIslandDisplayState(state, 1_200 + AGENT_ISLAND_COMPLETION_DWELL_MS + 1).totalCount).toBe(0);

    setAgentIslandVisibleSession(state, null, 7_000);
    const restored = buildAgentIslandDisplayState(state, 7_100);
    expect(restored.mode).toBe('expanded');
    expect(restored.displayPolicy).toBe('blocking');
    expect(restored.displaySurface).toBe('interactionCard');
    expect(restored.currentSessionId).toBe('ask');
  });

  it('waits for hover intent before expanding', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'running', title: 'Running' }, statusEvent(true, 'Running'), 1_000);

    setAgentIslandHovered(state, true, 1_050);

    expect(buildAgentIslandDisplayState(state, 1_400).mode).toBe('compact');
    expect(buildAgentIslandDisplayState(state, 1_400).shadowVisible).toBe(true);
    expect(buildAgentIslandDisplayState(state, 1_560).mode).toBe('expanded');
    expect(buildAgentIslandDisplayState(state, 1_560).shadowVisible).toBe(true);
  });

  it('expands immediately when the compact island is clicked', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'running', title: 'Running' }, statusEvent(true, 'Running'), 1_000);

    expect(requestAgentIslandManualExpand(state)).toBe(true);

    const display = buildAgentIslandDisplayState(state, 1_051);
    expect(display.mode).toBe('expanded');
    expect(display.notchStatus).toBe('expanded');
    expect(display.displayPolicy).toBe('manualExpanded');
    expect(display.displaySurface).toBe('sessionList');
  });

  it('does not expand from pending hover while the island is being dragged', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'running', title: 'Running' }, statusEvent(true, 'Running'), 1_000);
    setAgentIslandHovered(state, true, 1_050);
    expect(setAgentIslandLayoutDragActive(state, true)).toBe(true);

    const display = buildAgentIslandDisplayState(state, 1_800);

    expect(display.mode).toBe('compact');
    expect(display.displaySurface).toBe('collapsed');
  });

  it('does not collapse an expanded island while the island is being dragged', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'running', title: 'Running' }, statusEvent(true, 'Running'), 1_000);
    setAgentIslandHovered(state, true, 1_050);
    expect(buildAgentIslandDisplayState(state, 1_560).mode).toBe('expanded');

    expect(setAgentIslandLayoutDragActive(state, true)).toBe(true);
    setAgentIslandHovered(state, false, 1_570);
    const display = buildAgentIslandDisplayState(state, 2_000);

    expect(display.mode).toBe('expanded');
    expect(display.displaySurface).toBe('sessionList');
  });

  it('defers mouse-leave collapse briefly after hover expansion', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'running', title: 'Running' }, statusEvent(true, 'Running'), 1_000);
    setAgentIslandHovered(state, true, 1_050);
    expect(buildAgentIslandDisplayState(state, 1_560).mode).toBe('expanded');

    setAgentIslandHovered(state, false, 1_570);

    expect(buildAgentIslandDisplayState(state, 1_640).mode).toBe('expanded');
    expect(buildAgentIslandDisplayState(state, 1_740).mode).toBe('expanded');
    expect(buildAgentIslandDisplayState(state, 2_560).mode).toBe('compact');
  });

  it('collapses a manual session list only after the clicked session becomes visible', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'a', title: 'A', agentKind: 'codex' }, statusEvent(true, 'Running'), 1_000);
    applyAgentIslandEvent(state, { sessionId: 'b', title: 'B', agentKind: 'codex' }, statusEvent(true, 'Running'), 1_100);
    setAgentIslandHovered(state, true, 1_200);
    expect(buildAgentIslandDisplayState(state, 1_800).displaySurface).toBe('sessionList');

    expect(requestAgentIslandSessionFocus(state, 'b', 1_850)).toBe(true);
    expect(buildAgentIslandDisplayState(state, 1_900).displaySurface).toBe('sessionList');

    expect(setAgentIslandVisibleSession(state, 'a', 1_950)).toBe(true);
    expect(buildAgentIslandDisplayState(state, 2_000).displaySurface).toBe('sessionList');

    expect(setAgentIslandVisibleSession(state, 'b', 2_050)).toBe(true);
    const collapsed = buildAgentIslandDisplayState(state, 2_100);
    expect(collapsed.mode).toBe('compact');
    expect(collapsed.displaySurface).toBe('collapsed');
    expect(collapsed.currentSessionId).toBe('b');
  });

  it('collapses a manual session list when the clicked split-pane session is already visible', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'a', title: 'A', agentKind: 'codex' }, statusEvent(true, 'Running'), 1_000);
    applyAgentIslandEvent(state, { sessionId: 'b', title: 'B', agentKind: 'codex' }, statusEvent(true, 'Running'), 1_100);
    setAgentIslandVisibleSession(state, ['a', 'b'], 1_150);
    setAgentIslandHovered(state, true, 1_200);
    expect(buildAgentIslandDisplayState(state, 1_800).displaySurface).toBe('sessionList');

    expect(requestAgentIslandSessionFocus(state, 'b', 1_850)).toBe(true);

    const collapsed = buildAgentIslandDisplayState(state, 1_900);
    expect(collapsed.mode).toBe('compact');
    expect(collapsed.displaySurface).toBe('collapsed');
    expect(getNextAgentIslandTimerAt(state, 1_900)).toBeNull();
  });

  it('dismisses the first permission approval card after the clicked session becomes visible', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'ask', title: 'Ask', agentKind: 'codex' }, statusEvent(true, 'Running'), 1_000);
    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask', agentKind: 'codex' }, permissionRequest('r1'), 1_100);
    const initial = buildAgentIslandDisplayState(state, 1_150);
    expect(initial.mode).toBe('expanded');
    expect(initial.displaySurface).toBe('interactionCard');
    expect(initial.sessions[0]?.permissionAction).toMatchObject({ requestId: 'r1' });

    expect(requestAgentIslandSessionFocus(state, 'ask', 1_200)).toBe(true);
    expect(setAgentIslandVisibleSession(state, 'ask', 1_250)).toBe(true);

    const collapsed = buildAgentIslandDisplayState(state, 1_300);
    expect(collapsed.mode).toBe('compact');
    expect(collapsed.displaySurface).toBe('collapsed');
    expect(collapsed.currentSessionId).toBe('ask');
    expect(collapsed.sessions[0]?.permissionAction).toMatchObject({ requestId: 'r1' });
  });

  it('dismisses the first permission approval card when the clicked session is already visible', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'ask', title: 'Ask', agentKind: 'codex' }, statusEvent(true, 'Running'), 1_000);
    setAgentIslandAppFocused(state, true, 1_050);
    setAgentIslandVisibleSession(state, 'ask', 1_075);
    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask', agentKind: 'codex' }, permissionRequest('r1'), 1_100);
    const initial = buildAgentIslandDisplayState(state, 1_150);
    expect(initial.mode).toBe('expanded');
    expect(initial.displaySurface).toBe('interactionCard');
    expect(initial.sessions[0]?.permissionAction).toMatchObject({ requestId: 'r1' });

    expect(requestAgentIslandSessionFocus(state, 'ask', 1_200)).toBe(true);

    const collapsed = buildAgentIslandDisplayState(state, 1_250);
    expect(collapsed.mode).toBe('compact');
    expect(collapsed.displaySurface).toBe('collapsed');
    expect(collapsed.currentSessionId).toBe('ask');
    expect(collapsed.sessions[0]?.permissionAction).toMatchObject({ requestId: 'r1' });
  });

  it('reports hover and collapse deadlines as display timers', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'running', title: 'Running' }, statusEvent(true, 'Running'), 1_000);

    setAgentIslandHovered(state, true, 1_050);

    expect(getNextAgentIslandTimerAt(state, 1_060)).toBe(1_550);
  });

  it('defers transient completion removal while the pointer is hovering the island', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Done' }, doneEvent(), 2_000);
    setAgentIslandHovered(state, true, 2_500);

    const display = buildAgentIslandDisplayState(state, 20_000);

    expect(display.visible).toBe(true);
    expect(display.currentSessionId).toBe('done');
    expect(display.mode).toBe('compact');
    expect(display.displayPolicy).toBe('transient');
    expect(display.pillSnapshot.unreadCompletedCount).toBe(1);
  });

  it('keeps unread completion visible after dwell until it is manually viewed', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Done' }, doneEvent(), 2_000);

    const display = buildAgentIslandDisplayState(state, 20_000);

    expect(display.visible).toBe(true);
    expect(display.currentSessionId).toBe('done');
    expect(display.totalCount).toBe(1);
    expect(display.mode).toBe('compact');
    expect(display.shadowVisible).toBe(false);
    expect(display.pillSnapshot.unreadCompletedCount).toBe(1);
  });

  it('keeps completion reveal expanded long enough to read before compacting', () => {
    const state = createAgentIslandState();
    applyAgentIslandUserPrompt(state, { sessionId: 'done', title: 'Done' }, 'draw an image', 1_000);
    applyAgentIslandEvent(state, { sessionId: 'done' }, finalTextEvent('图片已经生成好了，可以查看结果。'), 1_200);
    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Done' }, doneEvent(), 2_000);

    const stillExpanded = buildAgentIslandDisplayState(state, 8_500);
    expect(stillExpanded.mode).toBe('expanded');
    expect(stillExpanded.displaySurface).toBe('completionCard');

    const compactUnread = buildAgentIslandDisplayState(state, 14_200);
    expect(compactUnread.mode).toBe('compact');
    expect(compactUnread.pillSnapshot.unreadCompletedCount).toBe(1);
  });

  it('keeps unread completion ahead of running activity after reveal dwell expires', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'running', title: 'Running' }, statusEvent(true, 'Generating'), 1_000);
    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Done' }, doneEvent(), 2_000);
    expect(buildAgentIslandDisplayState(state, 2_100).currentSessionId).toBe('done');

    applyAgentIslandEvent(state, { sessionId: 'running', title: 'Running' }, statusEvent(true, 'Still running'), 3_000);
    const stillCompletion = buildAgentIslandDisplayState(state, 8_000);
    expect(stillCompletion.mode).toBe('expanded');
    expect(stillCompletion.displaySurface).toBe('completionCard');
    expect(stillCompletion.currentSessionId).toBe('done');
    expect(stillCompletion.sessions.map((session) => session.sessionId)).toEqual(['done']);
    expect(stillCompletion.pillSnapshot.activeSessionCount).toBe(1);

    const display = buildAgentIslandDisplayState(state, 14_200);

    expect(display.mode).toBe('compact');
    expect(display.currentSessionId).toBe('done');
    expect(display.sessions.map((session) => session.sessionId)).toEqual(['done', 'running']);
    expect(display.pillSnapshot.unreadCompletedCount).toBe(1);
  });

  it('keeps active completion reveal through a newly started task', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Done' }, doneEvent(), 2_000);
    expect(buildAgentIslandDisplayState(state, 2_100).currentSessionId).toBe('done');

    applyAgentIslandUserPrompt(state, { sessionId: 'new', title: 'New task' }, 'start another task', 2_300);
    const stillCompletion = buildAgentIslandDisplayState(state, 3_000);

    expect(stillCompletion.mode).toBe('expanded');
    expect(stillCompletion.displaySurface).toBe('completionCard');
    expect(stillCompletion.currentSessionId).toBe('done');
    expect(stillCompletion.sessions.map((session) => session.sessionId)).toEqual(['done']);
    expect(stillCompletion.pillSnapshot.activeSessionCount).toBe(1);
  });

  it('shows running sessions only for manual hover expansion, not completion auto expansion', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'running', title: 'Running' }, statusEvent(true, 'Working'), 1_000);
    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Done' }, doneEvent(), 2_000);

    const autoExpanded = buildAgentIslandDisplayState(state, 2_100);
    expect(autoExpanded.mode).toBe('expanded');
    expect(autoExpanded.displayPolicy).toBe('transient');
    expect(autoExpanded.displaySurface).toBe('completionCard');
    expect(autoExpanded.sessions.map((session) => session.sessionId)).toEqual(['done']);
    expect(autoExpanded.pillSnapshot.activeSessionCount).toBe(1);

    setAgentIslandHovered(state, true, 14_100);
    const manualExpanded = buildAgentIslandDisplayState(state, 14_700);
    expect(manualExpanded.mode).toBe('expanded');
    expect(manualExpanded.displayPolicy).toBe('manualExpanded');
    expect(manualExpanded.displaySurface).toBe('sessionList');
    expect(manualExpanded.sessions.map((session) => session.sessionId)).toEqual(['done', 'running']);
  });

  it('stacks newer completion reveals without displacing the active completion', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'first', title: 'First' }, doneEvent(), 2_000);
    expect(buildAgentIslandDisplayState(state, 2_100).currentSessionId).toBe('first');

    applyAgentIslandEvent(state, { sessionId: 'second', title: 'Second' }, doneEvent(), 2_300);
    const stacked = buildAgentIslandDisplayState(state, 2_500);

    expect(stacked.mode).toBe('expanded');
    expect(stacked.displayPolicy).toBe('transient');
    expect(stacked.displaySurface).toBe('sessionList');
    expect(stacked.currentSessionId).toBe('first');
    expect(stacked.sessions.map((session) => session.sessionId)).toEqual(['first', 'second']);
    expect(stacked.pillSnapshot.unreadCompletedCount).toBe(2);
  });

  it('orders completed sessions first in the expanded session list', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'running', title: 'Running' }, statusEvent(true, 'Generating'), 1_000);
    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Done' }, doneEvent(), 2_000);
    applyAgentIslandEvent(state, { sessionId: 'running', title: 'Running' }, statusEvent(true, 'Still running'), 3_000);

    setAgentIslandHovered(state, true, 14_100);
    const display = buildAgentIslandDisplayState(state, 14_700);

    expect(display.mode).toBe('expanded');
    expect(display.displaySurface).toBe('sessionList');
    expect(display.currentSessionId).toBe('done');
    expect(display.sessions.map((session) => session.sessionId)).toEqual(['done', 'running']);
    expect(display.pillSnapshot.unreadCompletedCount).toBe(1);
  });

  it('promotes completed sessions while preserving same-phase expanded order', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'a', title: 'A' }, statusEvent(true, 'First'), 1_000);
    applyAgentIslandEvent(state, { sessionId: 'b', title: 'B' }, statusEvent(true, 'Second'), 1_100);
    setAgentIslandHovered(state, true, 1_200);

    const expanded = buildAgentIslandDisplayState(state, 1_800);
    expect(expanded.mode).toBe('expanded');
    expect(expanded.sessions.map((session) => session.sessionId)).toEqual(['b', 'a']);

    applyAgentIslandEvent(state, { sessionId: 'a', title: 'A' }, doneEvent(), 1_900);
    const completedPromoted = buildAgentIslandDisplayState(state, 2_000);

    expect(completedPromoted.mode).toBe('expanded');
    expect(completedPromoted.sessions.map((session) => session.sessionId)).toEqual(['a', 'b']);
    expect(completedPromoted.currentSessionId).toBe('a');
  });

  it('freezes session order while the island is expanded and resumes sorting after collapse', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'a', title: 'A' }, statusEvent(true, 'First'), 1_000);
    applyAgentIslandEvent(state, { sessionId: 'b', title: 'B' }, statusEvent(true, 'Second'), 1_100);
    setAgentIslandHovered(state, true, 1_200);

    const expanded = buildAgentIslandDisplayState(state, 1_800);
    expect(expanded.mode).toBe('expanded');
    expect(expanded.sessions.map((session) => session.sessionId)).toEqual(['b', 'a']);

    applyAgentIslandUserPrompt(state, { sessionId: 'a', title: 'A' }, 'Now latest', 1_900);
    const stillExpanded = buildAgentIslandDisplayState(state, 2_000);
    expect(stillExpanded.mode).toBe('expanded');
    expect(stillExpanded.sessions.map((session) => session.sessionId)).toEqual(['b', 'a']);
    expect(stillExpanded.currentSessionId).toBe('b');

    setAgentIslandHovered(state, false, 2_010);
    expect(buildAgentIslandDisplayState(state, 2_200).mode).toBe('expanded');

    const collapsed = buildAgentIslandDisplayState(state, 2_850);
    expect(collapsed.mode).toBe('compact');
    expect(collapsed.sessions.map((session) => session.sessionId)).toEqual(['a', 'b']);
    expect(collapsed.currentSessionId).toBe('a');
  });

  it('keeps unread completion after hover preview and mouse leave', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Done' }, doneEvent(), 2_000);
    setAgentIslandHovered(state, true, 2_100);
    expect(buildAgentIslandDisplayState(state, 2_650).mode).toBe('expanded');
    setAgentIslandHovered(state, false, 2_700);

    const display = buildAgentIslandDisplayState(state, 20_000);

    expect(display.visible).toBe(true);
    expect(display.currentSessionId).toBe('done');
    expect(display.totalCount).toBe(1);
    expect(display.mode).toBe('compact');
    expect(display.pillSnapshot.unreadCompletedCount).toBe(1);
  });

  it('removes completed sessions only after app attention is cleared', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Done' }, doneEvent(), 2_000);

    expect(acknowledgeAgentIslandSessionRead(state, 'done', 2_500)).toBe('cleared');
    const display = buildAgentIslandDisplayState(state, 20_000);

    expect(display.visible).toBe(true);
    expect(display.currentSessionId).toBeNull();
    expect(display.totalCount).toBe(0);
    expect(display.pillSnapshot.unreadCompletedCount).toBe(0);
  });

  it('protects active completion reveal briefly before outside click can collapse it', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Done' }, doneEvent(), 2_000);
    expect(buildAgentIslandDisplayState(state, 2_100).mode).toBe('expanded');

    expect(dismissAgentIslandActiveReveal(state, 2_200)).toBe(false);
    const protectedDisplay = buildAgentIslandDisplayState(state, 2_250);
    expect(protectedDisplay.mode).toBe('expanded');
    expect(protectedDisplay.displaySurface).toBe('completionCard');

    expect(dismissAgentIslandActiveReveal(state, 3_200)).toBe(true);
    const display = buildAgentIslandDisplayState(state, 3_250);

    expect(display.mode).toBe('compact');
    expect(display.displayPolicy).toBe('transient');
    expect(display.currentSessionId).toBe('done');
    expect(display.pillSnapshot.unreadCompletedCount).toBe(1);
  });

  it('protects stacked completion reveals briefly before outside click can collapse them', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'first', title: 'First' }, doneEvent(), 2_000);
    applyAgentIslandEvent(state, { sessionId: 'second', title: 'Second' }, doneEvent(), 2_100);
    expect(buildAgentIslandDisplayState(state, 2_200).currentSessionId).toBe('first');

    expect(dismissAgentIslandActiveReveal(state, 2_250)).toBe(false);
    const protectedDisplay = buildAgentIslandDisplayState(state, 2_300);
    expect(protectedDisplay.mode).toBe('expanded');
    expect(protectedDisplay.displaySurface).toBe('sessionList');

    expect(dismissAgentIslandActiveReveal(state, 3_300)).toBe(true);
    const display = buildAgentIslandDisplayState(state, 3_350);

    expect(display.mode).toBe('compact');
    expect(display.displayPolicy).toBe('transient');
    expect(display.sessions.map((session) => session.sessionId)).toEqual(['second', 'first']);
    expect(display.pillSnapshot.unreadCompletedCount).toBe(2);
  });

  it('collapses hover-expanded unread completion lists without clearing automatic reveals', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Done' }, doneEvent(), 2_000);
    setAgentIslandHovered(state, true, 20_000);
    buildAgentIslandDisplayState(state, 20_600);

    expect(dismissAgentIslandActiveReveal(state, 20_700)).toBe(true);
    const protectedDisplay = buildAgentIslandDisplayState(state, 20_800);
    expect(protectedDisplay.mode).toBe('expanded');

    const display = buildAgentIslandDisplayState(state, 21_700);

    expect(display.mode).toBe('compact');
    expect(display.displayPolicy).toBe('transient');
    expect(display.currentSessionId).toBe('done');
    expect(display.pillSnapshot.unreadCompletedCount).toBe(1);
  });

  it('returns to running when the last pending interaction is dismissed', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'ask', title: 'Ask' }, statusEvent(true, 'Running'), 1_000);
    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask' }, permissionRequest('r1'), 1_100);
    applyAgentIslandInteractionDismissed(state, 'ask', 'r1', 1_200);

    const display = buildAgentIslandDisplayState(state, 1_300);

    expect(display.currentSessionId).toBe('ask');
    expect(display.sessions[0]?.phase).toBe('running');
  });

  it('clears a pending permission when the matching tool starts', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'ask', title: 'Ask' }, statusEvent(true, 'Running'), 1_000);
    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask' }, permissionRequest('r1'), 1_100);

    applyAgentIslandEvent(state, { sessionId: 'ask', title: 'Ask' }, toolUseEvent('r1'), 1_200);
    const display = buildAgentIslandDisplayState(state, 1_250);

    expect(display.pillSnapshot.pendingInteractionCount).toBe(0);
    expect(display.sessions[0]).toMatchObject({
      phase: 'running',
      interactionKind: undefined,
      permissionAction: null,
    });
  });

  it('clears a pending permission when the matching tool result arrives', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'ask', title: 'Ask' }, statusEvent(true, 'Running'), 1_000);
    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask' }, permissionRequest('r1'), 1_100);

    applyAgentIslandEvent(state, { sessionId: 'ask', title: 'Ask' }, toolResultEvent('r1'), 1_200);
    const display = buildAgentIslandDisplayState(state, 1_250);

    expect(display.pillSnapshot.pendingInteractionCount).toBe(0);
    expect(display.sessions[0]).toMatchObject({
      phase: 'running',
      interactionKind: undefined,
      permissionAction: null,
    });
  });

  it('restores the previous pending permission action when the matching tool starts', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'ask', title: 'Ask' }, statusEvent(true, 'Running'), 1_000);
    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask' }, permissionRequest('r1'), 1_100);
    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask' }, permissionRequest('r2'), 1_200);

    applyAgentIslandEvent(state, { sessionId: 'ask', title: 'Ask' }, toolUseEvent('r2'), 1_300);
    const display = buildAgentIslandDisplayState(state, 1_350);

    expect(display.pillSnapshot.pendingInteractionCount).toBe(1);
    expect(display.sessions[0]).toMatchObject({
      phase: 'needs-interaction',
      interactionKind: 'permission',
      permissionAction: {
        requestId: 'r1',
      },
    });
  });

  it('keeps the first pending permission action until it is dismissed', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'ask', title: 'Ask' }, statusEvent(true, 'Running'), 1_000);
    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask' }, permissionRequest('r1'), 1_100);
    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask' }, permissionRequest('r2'), 1_200);

    expect(buildAgentIslandDisplayState(state, 1_250).sessions[0]?.permissionAction).toMatchObject({
      requestId: 'r1',
    });

    applyAgentIslandInteractionDismissed(state, 'ask', 'r1', 1_300);
    const display = buildAgentIslandDisplayState(state, 1_350);

    expect(display.sessions[0]).toMatchObject({
      phase: 'needs-interaction',
      interactionKind: 'permission',
      permissionAction: {
        requestId: 'r2',
      },
    });
  });

  it('restores the queued permission detail when the first permission is dismissed', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'ask', title: 'Ask' }, statusEvent(true, 'Running'), 1_000);
    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask' }, {
      ...permissionRequest('r1'),
      input: { command: 'pnpm test' },
    }, 1_100);
    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask' }, {
      ...permissionRequest('r2'),
      input: { command: 'pnpm lint' },
    }, 1_200);

    // 权限确认:人话意图作语境,真实命令保持可见。
    expect(buildAgentIslandDisplayState(state, 1_250).sessions[0]?.detail).toBe('运行测试 · $ pnpm test');

    applyAgentIslandInteractionDismissed(state, 'ask', 'r1', 1_300);
    const display = buildAgentIslandDisplayState(state, 1_350);

    expect(display.sessions[0]).toMatchObject({
      permissionAction: { requestId: 'r2' },
      detail: '代码检查 · $ pnpm lint',
    });
  });

  it('restores the queued permission detail when the first matching tool starts', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'ask', title: 'Ask' }, statusEvent(true, 'Running'), 1_000);
    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask' }, {
      ...permissionRequest('r1'),
      input: { command: 'pnpm test' },
    }, 1_100);
    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask' }, {
      ...permissionRequest('r2'),
      input: { command: 'pnpm lint' },
    }, 1_200);

    applyAgentIslandEvent(state, { sessionId: 'ask', title: 'Ask' }, toolUseEvent('r1'), 1_300);
    const display = buildAgentIslandDisplayState(state, 1_350);

    expect(display.sessions[0]).toMatchObject({
      permissionAction: { requestId: 'r2' },
      detail: '代码检查 · $ pnpm lint',
    });
  });

  it('shows Codex tool-side permission questions in the permission detail', () => {
    const state = createAgentIslandState();
    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask' }, {
      kind: 'permission',
      requestId: 'r1',
      toolName: 'mcp:third_party:block_contacts',
      input: {
        itemId: 'mcp-call-1',
        questions: [
          { id: 'confirm', header: 'Confirm', question: 'Continue?' },
          { id: 'scope', header: 'Scope', question: 'Apply to all contacts?' },
        ],
      },
    }, 1_000);

    const display = buildAgentIslandDisplayState(state, 1_100);

    expect(display.sessions[0]?.detail).toBe('Continue? (+1)');
  });

  it('keeps the current permission action when an older pending permission is dismissed', () => {
    const state = createAgentIslandState();
    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask' }, permissionRequest('r1'), 1_000);
    applyAgentIslandInteractionRequest(state, { sessionId: 'ask', title: 'Ask' }, permissionRequest('r2'), 1_100);

    applyAgentIslandInteractionDismissed(state, 'ask', 'r1', 1_200);
    const display = buildAgentIslandDisplayState(state, 1_250);

    expect(display.sessions[0]).toMatchObject({
      phase: 'needs-interaction',
      interactionKind: 'permission',
      permissionAction: {
        requestId: 'r2',
      },
    });
  });
});

describe('Agent Island error read semantics (已读以 App 内真实展示为准)', () => {
  it('keeps an unread error entry even when the session is visible and app focused (smart suppress must not eat unread)', () => {
    const state = createAgentIslandState();
    setAgentIslandVisibleSession(state, 'err', 1_900);
    setAgentIslandAppFocused(state, true, 1_950);
    applyAgentIslandEvent(state, { sessionId: 'err', title: 'Err' }, statusEvent(true, 'Running'), 1_980);

    applyAgentIslandEvent(state, { sessionId: 'err', title: 'Err' }, terminalErrorEvent('boom'), 2_000);

    // errorUntil(12s)过期很久之后条目依然保留:未读报错绝不能被 prune 静默删除。
    const display = buildAgentIslandDisplayState(state, 2_000 + 60_000);
    expect(display.totalCount).toBe(1);
    expect(display.sessions[0]).toMatchObject({ sessionId: 'err', phase: 'error', attention: true });
  });

  it('ignores passive read acks for unread error sessions but honors explicit acks', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'err', title: 'Err' }, terminalErrorEvent('boom'), 2_000);

    // 被动 ack(路由可见 / 窗口聚焦):不清、不删。
    expect(acknowledgeAgentIslandSessionRead(state, 'err', 20_000, { source: 'passive' })).toBe('error-immune');
    let display = buildAgentIslandDisplayState(state, 21_000);
    expect(display.totalCount).toBe(1);
    expect(display.sessions[0]?.attention).toBe(true);

    // 显式 ack(renderer 确认报错 UI 真实展示后经 badge 桥接):清除并移除条目。
    expect(acknowledgeAgentIslandSessionRead(state, 'err', 22_000)).toBe('cleared');
    display = buildAgentIslandDisplayState(state, 23_000);
    expect(display.totalCount).toBe(0);
  });

  it('still lets passive acks clear unread completed sessions (unchanged behavior)', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Done' }, doneEvent(), 2_000);

    expect(acknowledgeAgentIslandSessionRead(state, 'done', 20_000, { source: 'passive' })).toBe('cleared');
    const display = buildAgentIslandDisplayState(state, 21_000);
    expect(display.totalCount).toBe(0);
  });

  it('preserves error unread when a pending interaction is dismissed after the terminal error', () => {
    const state = createAgentIslandState();
    applyAgentIslandInteractionRequest(state, { sessionId: 'err', title: 'Err' }, permissionRequest('r1'), 1_000);
    applyAgentIslandEvent(state, { sessionId: 'err', title: 'Err' }, terminalErrorEvent('boom'), 2_000);

    // 错误善后:maker 侧撤销 pending 权限请求,不能吞掉 error 的未读。
    applyAgentIslandInteractionDismissed(state, 'err', 'r1', 2_100);

    // error 的 12s 自动展开也不该被交互撤销打断。
    const during = buildAgentIslandDisplayState(state, 2_000 + 11_000);
    expect(during.mode).toBe('expanded');

    const display = buildAgentIslandDisplayState(state, 2_000 + 60_000);
    expect(display.totalCount).toBe(1);
    expect(display.sessions[0]).toMatchObject({ sessionId: 'err', phase: 'error', attention: true });
  });

  it('ignores a delayed repeated setup dismissal after completion attention is recorded', () => {
    const state = createAgentIslandState();
    applyAgentIslandInteractionRequest(
      state,
      { sessionId: 'done', title: 'Done' },
      { kind: 'plugin_setup', requestId: 'setup-1', detail: '连接账号' },
      1_000,
    );
    // Terminal setup snapshot retires the interaction before the resumed turn
    // emits done; the visual card itself is dismissed later after its grace.
    applyAgentIslandInteractionDismissed(state, 'done', 'setup-1', 1_500);
    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Done' }, doneEvent(), 2_000);
    expect(buildAgentIslandDisplayState(state, 2_100).sessions[0]).toMatchObject({
      phase: 'completed',
      attention: true,
    });

    applyAgentIslandInteractionDismissed(state, 'done', 'setup-1', 2_200);
    expect(buildAgentIslandDisplayState(state, 2_300).sessions[0]).toMatchObject({
      phase: 'completed',
      attention: true,
    });
  });

  it('keeps a failed turn in error through its accounting status Done and done events', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'err', title: 'Err' }, statusEvent(true, 'Running'), 1_900);
    applyAgentIslandEvent(state, { sessionId: 'err', title: 'Err' }, terminalErrorEvent('upstream unreachable'), 2_000);
    applyAgentIslandEvent(state, { sessionId: 'err', title: 'Err' }, statusEvent(false, 'Done'), 2_001);
    applyAgentIslandEvent(state, { sessionId: 'err', title: 'Err' }, doneEvent(), 2_002);

    const display = buildAgentIslandDisplayState(state, 2_100);
    expect(display.sessions[0]).toMatchObject({
      sessionId: 'err',
      phase: 'error',
      attention: true,
      detail: 'upstream unreachable',
    });
  });

  it('keeps an unplanned remote daemon close in error when its paired done arrives', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(
      state,
      { sessionId: 'remote', title: 'Remote' },
      terminalErrorEvent('[REMOTE_DAEMON_CLOSED] ...', REMOTE_DAEMON_CLOSED_REASON),
      2_000,
    );
    applyAgentIslandEvent(state, { sessionId: 'remote', title: 'Remote' }, doneEvent(), 2_001);

    expect(buildAgentIslandDisplayState(state, 2_100).sessions[0]).toMatchObject({
      sessionId: 'remote',
      phase: 'error',
      attention: true,
    });
  });

  it('converges to completed when a paired done follows a planned remote daemon close', () => {
    // cc-mgr 计划升级:maker-core 对 remote_daemon_closed 先 push error 再成对
    // push done(claude-code/index.ts)。done 会把 phase 收敛为 completed 并按
    // completion 语义重算 unread —— error 的 forceUnread 不会残留成卡死的假报错。
    const state = createAgentIslandState();
    setAgentIslandVisibleSession(state, 'up', 1_900);
    setAgentIslandAppFocused(state, true, 1_950);
    applyAgentIslandEvent(
      state,
      { sessionId: 'up', title: 'Upgrade' },
      terminalErrorEvent('[REMOTE_DAEMON_CLOSED] ...', REMOTE_DAEMON_CLOSED_REASON),
      2_000,
      { allowCompletionAfterTerminalError: true },
    );
    applyAgentIslandEvent(state, { sessionId: 'up', title: 'Upgrade' }, doneEvent(), 2_001);

    const display = buildAgentIslandDisplayState(state, 2_100);
    expect(display.sessions[0]?.phase).toBe('completed');

    // completed 沿用被动已读语义:切会话 / 聚焦即可清,不会像未读 error 一样驻留。
    expect(acknowledgeAgentIslandSessionRead(state, 'up', 2_200, { source: 'passive' })).toBe('cleared');
    expect(buildAgentIslandDisplayState(state, 2_300).totalCount).toBe(0);
  });

  it('keeps the error transient reveal open for the extended error dwell (12s, not the generic 5s)', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'err', title: 'Err' }, terminalErrorEvent('boom'), 2_000);

    // 通用 5s reveal 已过、12s 未到:报错卡片仍应处于自动展开态。
    const during = buildAgentIslandDisplayState(state, 2_000 + 11_000);
    expect(during.mode).toBe('expanded');

    // 12s 之后自动收起(回到 compact),但条目(未读)仍在列表里。
    const after = buildAgentIslandDisplayState(state, 2_000 + 13_000);
    expect(after.mode).toBe('compact');
    expect(after.totalCount).toBe(1);
  });
});

describe('Agent Island 未读驻留 TTL(避免几小时前完成的任务无限期霸占展开列表)', () => {
  it('unread completed 条目在 TTL 内仍然可见', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Schedule' }, doneEvent(), 2_000);

    // TTL 边界前 1 秒:仍然算未读驻留期,条目在列表里。
    const beforeExpiry = buildAgentIslandDisplayState(state, 2_000 + AGENT_ISLAND_UNREAD_TRANSIENT_TTL_MS - 1_000);
    expect(beforeExpiry.totalCount).toBe(1);
    expect(beforeExpiry.sessions[0]).toMatchObject({ sessionId: 'done', phase: 'completed' });
  });

  it('unread completed 条目超过 TTL 后从灵动岛列表 prune 掉', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Schedule' }, doneEvent(), 2_000);

    // TTL 边界后 1 秒:即使还没被 ack,也不再让它占展开列表。
    const afterExpiry = buildAgentIslandDisplayState(state, 2_000 + AGENT_ISLAND_UNREAD_TRANSIENT_TTL_MS + 1_000);
    expect(afterExpiry.totalCount).toBe(0);
  });

  it('unread error 条目超过 TTL 后也从灵动岛列表 prune 掉', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'err', title: 'Err' }, terminalErrorEvent('boom'), 2_000);

    // TTL 边界前:未读 error 仍然驻留(既有 60s 后仍可见的用例覆盖了 TTL 内区间,这里
    // 只再验证 TTL 边界后被 prune 掉,防止长时间遗留报错霸占展开视图)。
    const afterExpiry = buildAgentIslandDisplayState(state, 2_000 + AGENT_ISLAND_UNREAD_TRANSIENT_TTL_MS + 1_000);
    expect(afterExpiry.totalCount).toBe(0);
  });

  it('TTL 过期后悬停展开也不应复活 unread completed 条目(preserveExpiredTransient 不绕过 TTL)', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'done', title: 'Schedule' }, doneEvent(), 2_000);

    // 模拟 TTL 后用户悬停打开灵动岛展开列表
    const afterExpiry = 2_000 + AGENT_ISLAND_UNREAD_TRANSIENT_TTL_MS + 5_000;
    setAgentIslandHovered(state, true, afterExpiry);

    // preserveExpiredTransient=true 时也不应把 TTL 过期的 unread 条目捞回来
    const display = buildAgentIslandDisplayState(state, afterExpiry);
    expect(display.totalCount).toBe(0);
  });

  it('TTL 过期后悬停展开也不应复活 unread error 条目', () => {
    const state = createAgentIslandState();
    applyAgentIslandEvent(state, { sessionId: 'err', title: 'Err' }, terminalErrorEvent('boom'), 2_000);

    const afterExpiry = 2_000 + AGENT_ISLAND_UNREAD_TRANSIENT_TTL_MS + 5_000;
    setAgentIslandHovered(state, true, afterExpiry);

    const display = buildAgentIslandDisplayState(state, afterExpiry);
    expect(display.totalCount).toBe(0);
  });
});
