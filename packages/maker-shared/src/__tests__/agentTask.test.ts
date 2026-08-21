import { describe, expect, it } from 'vitest';
import {
  applyAgentTaskUpdateEvent,
  buildAgentTaskCardModel,
  deriveAgentTaskStatus,
  findAgentTaskUpdate,
  isAgentTaskToolName,
  isSubagentSpawnToolName,
  mergeAgentTaskUpdate,
  PI_SUBAGENT_TOOL_NAME,
  normalizeAgentTaskUpdate,
  normalizeWorkflowProgressEntries,
  subagentSpawnResultIndicatesRunning,
  type AgentTaskUpdate,
  type WorkflowProgressEntry,
} from '../agentTask.js';

const NOW = '2026-06-24T00:00:00.000Z';

describe('isAgentTaskToolName', () => {
  it('matches Task / Agent / collab:* and nothing else', () => {
    expect(isAgentTaskToolName('Task')).toBe(true);
    expect(isAgentTaskToolName('Agent')).toBe(true);
    expect(isAgentTaskToolName('collab:spawn')).toBe(true);
    expect(isAgentTaskToolName('Read')).toBe(false);
    expect(isAgentTaskToolName('TodoWrite')).toBe(false);
    expect(isAgentTaskToolName('')).toBe(false);
  });

  it('matches the PI subagent tool so its card renders like Claude / Codex', () => {
    // 这条判据是三家 harness 唯一的卡片入口:漏了 PI 的工具名,子代理调用会**静默**落进普通
    // 工具组 —— 不报错、不缺数据,只是卡片不出现,极难从日志发现(review 要求补覆盖)。
    expect(isAgentTaskToolName(PI_SUBAGENT_TOOL_NAME)).toBe(true);
    // 用字面量再钉一次:常量与判据一起被改坏时,只断言常量的测试会一起变绿。
    expect(isAgentTaskToolName('subagent')).toBe(true);
    expect(PI_SUBAGENT_TOOL_NAME).toBe('subagent');
    // 大小写与近似名不得误命中(pi 工具名是精确匹配,不是前缀/模糊)。
    expect(isAgentTaskToolName('Subagent')).toBe(false);
    expect(isAgentTaskToolName('subagents')).toBe(false);
    expect(isAgentTaskToolName('sub-agent')).toBe(false);
  });
});

describe('isSubagentSpawnToolName', () => {
  it('separates real launches from Codex control cards', () => {
    for (const name of ['Task', 'Agent', 'subagent', 'collab:spawn', 'collab:spawnAgent']) {
      expect(isSubagentSpawnToolName(name)).toBe(true);
    }
    for (const name of ['collab:wait', 'collab:sendInput', 'collab:resumeAgent', 'collab:closeAgent']) {
      expect(isSubagentSpawnToolName(name)).toBe(false);
      expect(isAgentTaskToolName(name)).toBe(true);
    }
  });
});

describe('subagentSpawnResultIndicatesRunning', () => {
  it('fails closed when a tool result is missing', () => {
    expect(subagentSpawnResultIndicatesRunning('Agent', undefined)).toBe(false);
    expect(subagentSpawnResultIndicatesRunning('Task', null)).toBe(false);
    expect(subagentSpawnResultIndicatesRunning('collab:spawnAgent', undefined)).toBe(false);
  });
});

describe('normalizeAgentTaskUpdate', () => {
  it('returns null without a taskId or parentToolUseId', () => {
    expect(normalizeAgentTaskUpdate(null)).toBeNull();
    expect(normalizeAgentTaskUpdate({})).toBeNull();
    expect(normalizeAgentTaskUpdate({ status: 'running' })).toBeNull();
  });

  it('defaults status to running and infers provider from source', () => {
    const update = normalizeAgentTaskUpdate({ taskId: 't1', status: 'weird' }, 'codex');
    expect(update).toMatchObject({ taskId: 't1', status: 'running', provider: 'codex' });
    expect(normalizeAgentTaskUpdate({ taskId: 't2' }, 'pi'))
      .toMatchObject({ taskId: 't2', provider: 'pi' });
  });

  it('keeps an explicit provider over the source hint and shapes usage', () => {
    const update = normalizeAgentTaskUpdate(
      { taskId: 't1', provider: 'claude-code', status: 'completed', usage: { totalTokens: 50, junk: 'x' } },
      'codex',
    );
    expect(update?.provider).toBe('claude-code');
    expect(update?.usage).toEqual({ totalTokens: 50 });
  });

  it('falls back taskId to parentToolUseId when only the latter is present', () => {
    const update = normalizeAgentTaskUpdate({ parentToolUseId: 'tu-9', status: 'failed' });
    expect(update).toMatchObject({ taskId: 'tu-9', parentToolUseId: 'tu-9', status: 'failed' });
  });
});

describe('deriveAgentTaskStatus', () => {
  it('keeps a persisted failed or stopped terminal state when replaying a non-empty result', () => {
    expect(deriveAgentTaskStatus(undefined, 'Error: child failed', {
      persistedStatus: 'failed',
    })).toBe('failed');
    expect(deriveAgentTaskStatus('running', 'Interrupted by user', {
      persistedStatus: 'stopped',
    })).toBe('stopped');
  });

  it('ignores malformed persisted status and preserves the legacy replay fallback', () => {
    expect(deriveAgentTaskStatus(undefined, 'done', {
      persistedStatus: 'cancelled' as never,
    })).toBe('completed');
  });
});

describe('mergeAgentTaskUpdate', () => {
  it('lets newer non-empty fields win but preserves the original createdAt', () => {
    const prev: AgentTaskUpdate = { provider: 'codex', taskId: 't1', status: 'running', title: 'old', createdAt: 'c0' };
    const next: AgentTaskUpdate = { provider: 'codex', taskId: 't1', status: 'completed', summary: 'done', updatedAt: 'u1' };
    expect(mergeAgentTaskUpdate(prev, next)).toMatchObject({
      status: 'completed',
      title: 'old',
      summary: 'done',
      createdAt: 'c0',
      updatedAt: 'u1',
    });
  });

  it('returns next verbatim when there is no prior', () => {
    const next: AgentTaskUpdate = { provider: 'codex', taskId: 't1', status: 'running' };
    expect(mergeAgentTaskUpdate(undefined, next)).toBe(next);
  });

  it('clears a stale model when a live update explicitly sends null', () => {
    const first = applyAgentTaskUpdateEvent(
      undefined,
      { provider: 'codex', taskId: 't1', status: 'running', model: 'codex/gpt-5.5' },
      'codex',
      NOW,
    )!;
    const cleared = applyAgentTaskUpdateEvent(
      first,
      { provider: 'codex', taskId: 't1', status: 'running', model: null },
      'codex',
      '2026-06-24T00:00:01.000Z',
    )!;
    expect(cleared.get('t1')?.model).toBeNull();
  });
});

describe('applyAgentTaskUpdateEvent', () => {
  it('indexes a task under both its taskId and parentToolUseId', () => {
    const map = applyAgentTaskUpdateEvent(undefined, { taskId: 'task-1', parentToolUseId: 'tu-1', status: 'running' }, 'claude-code', NOW);
    expect(map).not.toBeNull();
    expect(map!.get('task-1')).toBe(map!.get('tu-1'));
    expect(map!.get('tu-1')?.createdAt).toBe(NOW);
  });

  it('merges a follow-up update onto the same task across its aliases', () => {
    const first = applyAgentTaskUpdateEvent(undefined, { parentToolUseId: 'tu-1', status: 'running', title: 'Work' }, 'claude-code', NOW)!;
    const second = applyAgentTaskUpdateEvent(first, { taskId: 'task-1', parentToolUseId: 'tu-1', status: 'completed', summary: 'ok' }, 'claude-code', '2026-06-24T00:01:00.000Z')!;
    const merged = second.get('tu-1');
    expect(merged).toMatchObject({ status: 'completed', title: 'Work', summary: 'ok', createdAt: NOW });
    expect(second.get('task-1')).toBe(merged);
  });

  it('returns null for an un-linkable payload', () => {
    expect(applyAgentTaskUpdateEvent(undefined, { status: 'running' }, 'codex', NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// workflow_progress:字段无公开契约(SDK .d.ts 未声明,CLI 运行时携带),入口
// 必须防御收窄;CLI 对纯心跳帧节流省略整个数组 = 沿用上一帧,merge 不得清树。
// ---------------------------------------------------------------------------

describe('normalizeWorkflowProgressEntries', () => {
  it('非数组一律返回 undefined', () => {
    expect(normalizeWorkflowProgressEntries(undefined)).toBeUndefined();
    expect(normalizeWorkflowProgressEntries(null)).toBeUndefined();
    expect(normalizeWorkflowProgressEntries({})).toBeUndefined();
    expect(normalizeWorkflowProgressEntries('workflow_phase')).toBeUndefined();
    expect(normalizeWorkflowProgressEntries(42)).toBeUndefined();
  });

  it('坏条目(非对象 / 缺 type / type 词表外 / index 非有限数)逐条跳过,好条目保留', () => {
    const entries = normalizeWorkflowProgressEntries([
      null,
      'junk',
      { index: 0 },
      { type: 'workflow_step', index: 0 },
      { type: 'workflow_agent' },
      { type: 'workflow_agent', index: Number.NaN },
      { type: 'workflow_agent', index: Number.POSITIVE_INFINITY },
      { type: 'workflow_agent', index: '1' },
      { type: 'workflow_phase', index: 0, title: 'Phase A' },
      { type: 'workflow_agent', index: 1, label: 'worker-a', state: 'progress' },
    ]);
    expect(entries).toEqual([
      { type: 'workflow_phase', index: 0, title: 'Phase A' },
      { type: 'workflow_agent', index: 1, label: 'worker-a', state: 'progress' },
    ]);
  });

  it('超长字符串截到各自上限并以 … 结尾(lastToolSummary 160 / resultPreview 300 / label 200)', () => {
    const entries = normalizeWorkflowProgressEntries([
      {
        type: 'workflow_agent',
        index: 0,
        label: 'L'.repeat(201),
        lastToolSummary: 'S'.repeat(161),
        resultPreview: 'R'.repeat(301),
      },
    ]);
    const entry = entries?.[0];
    expect(entry?.label).toHaveLength(200);
    expect(entry?.label?.endsWith('…')).toBe(true);
    expect(entry?.lastToolSummary).toHaveLength(160);
    expect(entry?.lastToolSummary?.endsWith('…')).toBe(true);
    expect(entry?.resultPreview).toHaveLength(300);
    expect(entry?.resultPreview?.endsWith('…')).toBe(true);
  });

  it('恰好等于上限的字符串原样透传,不加省略号', () => {
    const entries = normalizeWorkflowProgressEntries([
      { type: 'workflow_agent', index: 0, lastToolSummary: 'S'.repeat(160) },
    ]);
    expect(entries?.[0]?.lastToolSummary).toBe('S'.repeat(160));
  });

  it('条目数超过 2000 时丢弃多余(IPC/隧道 payload 体量收口)', () => {
    const raw = Array.from({ length: 2005 }, (_, i) => ({ type: 'workflow_agent', index: i }));
    const entries = normalizeWorkflowProgressEntries(raw);
    expect(entries).toHaveLength(2000);
    expect(entries?.[1999]).toMatchObject({ index: 1999 });
  });

  it('没有任何合法条目时返回 undefined(与节流帧"缺失=沿用旧树"同语义)', () => {
    expect(normalizeWorkflowProgressEntries([])).toBeUndefined();
    expect(normalizeWorkflowProgressEntries([null, { type: 'nope', index: 0 }])).toBeUndefined();
  });

  it('cached 布尔原样透传,非布尔丢弃', () => {
    const entries = normalizeWorkflowProgressEntries([
      { type: 'workflow_agent', index: 0, cached: true },
      { type: 'workflow_agent', index: 1, cached: false },
      { type: 'workflow_agent', index: 2, cached: 'yes' },
    ]);
    expect(entries?.[0]?.cached).toBe(true);
    expect(entries?.[1]?.cached).toBe(false);
    expect(entries && 'cached' in entries[2]).toBe(false);
  });
});

describe('normalizeAgentTaskUpdate · workflowProgress', () => {
  it('合法数组收窄后进入结果', () => {
    const update = normalizeAgentTaskUpdate({
      taskId: 't1',
      status: 'running',
      workflowProgress: [{ type: 'workflow_phase', index: 0, title: 'Phase A' }],
    });
    expect(update?.workflowProgress).toEqual([
      { type: 'workflow_phase', index: 0, title: 'Phase A' },
    ]);
  });

  it('非法(非数组 / 全坏条目)时字段整体缺失,而不是空数组', () => {
    const nonArray = normalizeAgentTaskUpdate({ taskId: 't1', status: 'running', workflowProgress: 'junk' });
    expect(nonArray).not.toBeNull();
    expect(nonArray && 'workflowProgress' in nonArray).toBe(false);
    const allBad = normalizeAgentTaskUpdate({ taskId: 't1', status: 'running', workflowProgress: [null, {}] });
    expect(allBad).not.toBeNull();
    expect(allBad && 'workflowProgress' in allBad).toBe(false);
  });
});

describe('mergeAgentTaskUpdate · workflowProgress keep-last', () => {
  const tree: WorkflowProgressEntry[] = [
    { type: 'workflow_agent', index: 0, label: 'worker-a', state: 'progress' },
  ];

  it('next 不带 workflowProgress(节流帧)时沿用 prev 的树,不清空', () => {
    const prev: AgentTaskUpdate = { provider: 'claude-code', taskId: 't1', status: 'running', workflowProgress: tree };
    const next: AgentTaskUpdate = { provider: 'claude-code', taskId: 't1', status: 'running' };
    expect(mergeAgentTaskUpdate(prev, next).workflowProgress).toBe(tree);
  });

  it('next 带 workflowProgress 时整树覆盖', () => {
    const newer: WorkflowProgressEntry[] = [
      { type: 'workflow_agent', index: 0, label: 'worker-a', state: 'done' },
    ];
    const prev: AgentTaskUpdate = { provider: 'claude-code', taskId: 't1', status: 'running', workflowProgress: tree };
    const next: AgentTaskUpdate = { provider: 'claude-code', taskId: 't1', status: 'running', workflowProgress: newer };
    expect(mergeAgentTaskUpdate(prev, next).workflowProgress).toBe(newer);
  });
});

describe('applyAgentTaskUpdateEvent · workflowProgress 节流帧保留', () => {
  it('第一帧带数组、第二帧不带(CLI 节流)→ map 中该任务仍保留数组', () => {
    const first = applyAgentTaskUpdateEvent(
      undefined,
      {
        taskId: 'wf-1',
        status: 'running',
        taskType: 'local_workflow',
        workflowProgress: [
          { type: 'workflow_phase', index: 0, title: 'Phase A' },
          { type: 'workflow_agent', index: 1, label: 'worker-a', state: 'start' },
        ],
      },
      'claude-code',
      NOW,
    );
    expect(first).not.toBeNull();
    const second = applyAgentTaskUpdateEvent(
      first!,
      { taskId: 'wf-1', status: 'running', lastToolName: 'Bash' },
      'claude-code',
      '2026-06-24T00:01:00.000Z',
    );
    const task = second?.get('wf-1');
    expect(task?.lastToolName).toBe('Bash');
    expect(task?.workflowProgress).toEqual([
      { type: 'workflow_phase', index: 0, title: 'Phase A' },
      { type: 'workflow_agent', index: 1, label: 'worker-a', state: 'start' },
    ]);
  });
});

describe('findAgentTaskUpdate', () => {
  const update: AgentTaskUpdate = { provider: 'codex', taskId: 't1', status: 'running' };
  const map = new Map<string, AgentTaskUpdate>([['tu-1', update], ['client-1', update]]);

  it('prefers toolUseId, then clientId', () => {
    expect(findAgentTaskUpdate(map, 'tu-1', 'client-1')).toBe(update);
    expect(findAgentTaskUpdate(map, 'missing', 'client-1')).toBe(update);
    expect(findAgentTaskUpdate(map, 'missing', 'missing')).toBeUndefined();
    expect(findAgentTaskUpdate(undefined, 'tu-1', 'client-1')).toBeUndefined();
  });
});

describe('buildAgentTaskCardModel', () => {
  it('REPRO: treats a paired final result as terminal when the live update is stale running', () => {
    const model = buildAgentTaskCardModel({
      toolName: 'collab:spawnAgent',
      result: 'child-thread: completed',
      update: {
        provider: 'codex',
        taskId: 'collab-1',
        parentToolUseId: 'collab-1',
        status: 'running',
      },
    });

    expect(model.status).toBe('completed');
  });

  it('REPRO: keeps a V1 spawn running when its paired result is a running state summary', () => {
    const model = buildAgentTaskCardModel({
      toolName: 'collab:spawnAgent',
      result: 'child-thread: running',
      update: {
        provider: 'codex',
        taskId: 'collab-1',
        parentToolUseId: 'collab-1',
        status: 'running',
      },
    });

    expect(model.status).toBe('running');
  });

  it('REPRO: keeps an async Claude Agent running for its launch receipt', () => {
    const model = buildAgentTaskCardModel({
      toolName: 'Agent',
      toolInput: { run_in_background: true, prompt: 'keep working' },
      result: 'Async agent launched successfully.',
      update: {
        provider: 'claude-code',
        taskId: 'agent-1',
        parentToolUseId: 'agent-1',
        status: 'running',
      },
    });

    expect(model.status).toBe('running');
  });

  it('REPRO: recognizes the full async Claude Agent launch receipt', () => {
    const model = buildAgentTaskCardModel({
      toolName: 'Agent',
      toolInput: { run_in_background: true, prompt: 'keep working' },
      result: [
        'Async agent launched successfully.',
        "agentId: agent-1 (internal ID - do not mention to user. Use SendMessage with to: 'agent-1' to continue this agent.)",
        'The agent is working in the background. You will be notified automatically when it completes.',
        'Briefly tell the user what you launched and end your response.',
      ].join('\n'),
      update: {
        provider: 'claude-code',
        taskId: 'agent-1',
        parentToolUseId: 'agent-1',
        status: 'running',
      },
    });

    expect(model.status).toBe('running');
  });

  it.each(['in_progress', 'in-progress', 'started', 'active'])(
    'keeps a V1 spawn running for the %s state summary',
    (state) => {
      const model = buildAgentTaskCardModel({
        toolName: 'collab:spawnAgent',
        result: `child-thread: ${state}`,
        update: {
          provider: 'codex',
          taskId: 'collab-1',
          parentToolUseId: 'collab-1',
          status: 'running',
        },
      });

      expect(model.status).toBe('running');
    },
  );

  it('preserves explicit failed and stopped terminal states when a result is present', () => {
    const input = {
      toolName: 'collab:spawnAgent',
      result: 'child-thread: terminal',
      update: {
        provider: 'codex' as const,
        taskId: 'collab-1',
        parentToolUseId: 'collab-1',
      },
    };
    expect(buildAgentTaskCardModel({ ...input, update: { ...input.update, status: 'failed' } }).status)
      .toBe('failed');
    expect(buildAgentTaskCardModel({ ...input, update: { ...input.update, status: 'stopped' } }).status)
      .toBe('stopped');
  });

  it('falls back the title through update → tool input description → prompt', () => {
    expect(buildAgentTaskCardModel({ update: { provider: 'codex', taskId: 't', status: 'running', title: 'From update' } }).title)
      .toBe('From update');
    expect(buildAgentTaskCardModel({ toolName: 'Task', toolInput: { description: 'From desc', prompt: 'p' } }).title)
      .toBe('From desc');
    expect(buildAgentTaskCardModel({ toolName: 'Task', toolInput: { prompt: 'Only prompt' } }).title)
      .toBe('Only prompt');
    expect(buildAgentTaskCardModel({ toolName: 'Task', toolInput: {} }).title).toBeNull();
  });

  it('infers status (result → completed) and provider (collab → codex), and surfaces usage', () => {
    const model = buildAgentTaskCardModel({
      toolName: 'collab:run',
      toolInput: { description: 'Sub task' },
      result: 'finished',
      update: { provider: 'codex', taskId: 't', status: 'completed', usage: { totalTokens: 9, toolUses: 2, durationMs: 5000 }, lastToolName: 'Bash' },
    });
    expect(model).toMatchObject({
      status: 'completed',
      provider: 'codex',
      summary: 'finished',
      totalTokens: 9,
      toolUses: 2,
      durationMs: 5000,
      lastToolName: 'Bash',
    });
  });

  it('defaults status to running with no update/result and provider from tool name', () => {
    const model = buildAgentTaskCardModel({ toolName: 'Task', toolInput: { description: 'x' } });
    expect(model.status).toBe('running');
    expect(model.provider).toBe('claude-code');
  });

  it('surfaces the codex spawn receipt as structured spawnedAgentName, not raw summary', () => {
    // translator 约定:collab:spawn 的 tool_result 只放 agentPath(= input.name)。
    const model = buildAgentTaskCardModel({
      toolName: 'collab:spawn',
      toolInput: { name: '/root/survey_startup', agentThreadId: 't-2' },
      result: '/root/survey_startup',
    });
    expect(model.spawnedAgentName).toBe('/root/survey_startup');
    // 裸路径不进 summary,各端用 spawnedAgentName 按 locale 组装句子。
    expect(model.summary).toBeUndefined();
    expect(model.status).toBe('completed');
    expect(model.provider).toBe('codex');
  });

  it('drops the spawn receipt once live subagent state exists (card parity with claude)', () => {
    // 子线程送来 tokens / 工具数后,title + 运行状态已表达同样信息;再显示
    // 「Subagent X 已启动」会让 codex 卡比 Claude 子代理卡多一行冗余文案。
    const model = buildAgentTaskCardModel({
      toolName: 'collab:spawn',
      toolInput: { name: '/root/survey_startup', agentThreadId: 't-2' },
      result: '/root/survey_startup',
      update: {
        provider: 'codex',
        taskId: 'spawn-1',
        status: 'running',
        title: '/root/survey_startup',
        usage: { totalTokens: 1200, toolUses: 3, durationMs: 4200 },
      },
    });
    expect(model.spawnedAgentName).toBeUndefined();
    // 裸 agentPath 同样不许漏进 summary。
    expect(model.summary).toBeUndefined();
    expect(model.status).toBe('running');
    expect(model.totalTokens).toBe(1200);
    expect(model.toolUses).toBe(3);
    expect(model.durationMs).toBe(4200);
  });

  it('leaves future rich collab:spawn results (agentsStates summaries) untouched', () => {
    const model = buildAgentTaskCardModel({
      toolName: 'collab:spawn',
      toolInput: { name: '/root/survey_startup' },
      result: 'thread-2: done',
    });
    expect(model.spawnedAgentName).toBeUndefined();
    expect(model.summary).toBe('thread-2: done');
  });
});
