import { describe, expect, it } from 'vitest';

import type { WorkflowProgressEntry } from '@cindy/maker-shared/agent-task';

import type {
  WorkflowAgentProgress,
  WorkflowProgress,
} from '../../../../../../shared/workflow-progress';
import { buildWorkflowTreeModel } from '../workflowProgressModel';

function phaseEntry(index: number, title: string): WorkflowProgressEntry {
  return { type: 'workflow_phase', index, title };
}

function agentEntry(
  index: number,
  overrides: Partial<WorkflowProgressEntry> = {},
): WorkflowProgressEntry {
  return { type: 'workflow_agent', index, ...overrides };
}

function fileAgent(overrides: Partial<WorkflowAgentProgress> = {}): WorkflowAgentProgress {
  return { label: 'a', agentId: 'file-a', state: 'done', ...overrides };
}

function fileProgress(overrides: Partial<WorkflowProgress> = {}): WorkflowProgress {
  return {
    runId: 'run-1',
    status: 'running',
    phases: [],
    agents: [],
    ...overrides,
  };
}

describe('buildWorkflowTreeModel', () => {
  it('两源都空时返回 null(undefined / 空数组 / null 各种组合)', () => {
    expect(buildWorkflowTreeModel({ taskStatus: 'running' })).toBeNull();
    expect(buildWorkflowTreeModel({ entries: [], fileProgress: null, taskStatus: 'running' })).toBeNull();
    expect(buildWorkflowTreeModel({ entries: undefined, fileProgress: undefined, taskStatus: 'completed' })).toBeNull();
  });

  it('entries 在场时主结构来自 entries:phase 顺序、按 phaseTitle 归组、孤儿归末尾 null 组', () => {
    const entries: WorkflowProgressEntry[] = [
      phaseEntry(0, 'Research'),
      phaseEntry(1, 'Write'),
      agentEntry(2, {
        agentId: 'a1',
        label: 'search:web',
        phaseTitle: 'Research',
        state: 'done',
        model: 'claude-haiku-4-5',
        resultPreview: 'found 3 sources',
      }),
      agentEntry(3, {
        agentId: 'a2',
        label: 'writer',
        phaseTitle: 'Write',
        state: 'progress',
        lastToolName: 'Write',
        lastToolSummary: 'draft.md',
        attempt: 2,
      }),
      agentEntry(4, { agentId: 'a3', label: 'stray', state: 'start' }),
    ];
    const model = buildWorkflowTreeModel({ entries, taskStatus: 'running' });
    expect(model).not.toBeNull();
    expect(model!.groups.map((g) => g.title)).toEqual(['Research', 'Write', null]);
    expect(model!.groups[0].agents).toEqual([
      {
        key: 'a1',
        label: 'search:web',
        state: 'done',
        model: 'claude-haiku-4-5',
        resultPreview: 'found 3 sources',
      },
    ]);
    expect(model!.groups[1].agents[0]).toMatchObject({
      key: 'a2',
      label: 'writer',
      state: 'progress',
      lastToolName: 'Write',
      lastToolSummary: 'draft.md',
      attempt: 2,
    });
    expect(model!.groups[2].agents[0]).toMatchObject({ key: 'a3', label: 'stray', state: 'start' });
  });

  it('entries 里没有 agent 的 phase 不产出分组;label 缺失回退 agentId', () => {
    const entries: WorkflowProgressEntry[] = [
      phaseEntry(0, 'Empty phase'),
      phaseEntry(1, 'Busy'),
      agentEntry(2, { agentId: 'only-id', phaseTitle: 'Busy', state: 'running' }),
    ];
    const model = buildWorkflowTreeModel({ entries, taskStatus: 'running' })!;
    expect(model.groups.map((g) => g.title)).toEqual(['Busy']);
    expect(model.groups[0].agents[0].label).toBe('only-id');
  });

  it('entries 缺失时整树退回 fileProgress,文件 state 词表原样保留', () => {
    const file = fileProgress({
      status: 'running',
      phases: [
        { index: 0, title: 'Phase A', detail: 'gather info' },
        { index: 1, title: 'Phase B' },
      ],
      agents: [
        fileAgent({ label: 'x', agentId: 'fx', phaseTitle: 'Phase A', state: 'done', durationMs: 4000, resultPreview: 'ok' }),
        fileAgent({ label: 'y', agentId: 'fy', phaseTitle: 'Phase B', state: 'killed', error: 'boom' }),
        fileAgent({ label: 'z', agentId: 'fz', phaseTitle: 'Unknown', state: 'queued' }),
      ],
    });
    const model = buildWorkflowTreeModel({ fileProgress: file, taskStatus: 'running' })!;
    expect(model.groups.map((g) => g.title)).toEqual(['Phase A', 'Phase B', null]);
    expect(model.groups[0].detail).toBe('gather info');
    expect(model.groups[0].agents[0]).toEqual({
      key: 'fx',
      label: 'x',
      state: 'done',
      durationMs: 4000,
      resultPreview: 'ok',
    });
    expect(model.groups[1].agents[0]).toMatchObject({ state: 'killed', error: 'boom' });
    expect(model.groups[2].agents[0]).toMatchObject({ label: 'z', state: 'queued' });
  });

  it('entries 在场时 logs 与 phase detail 从文件回填', () => {
    const entries: WorkflowProgressEntry[] = [
      phaseEntry(0, 'Research'),
      agentEntry(1, { agentId: 'a1', label: 'search', phaseTitle: 'Research', state: 'running' }),
    ];
    const file = fileProgress({
      logs: ['starting research', 'found sources'],
      phases: [{ index: 0, title: 'Research', detail: 'parallel web search' }],
      agents: [],
    });
    const model = buildWorkflowTreeModel({ entries, fileProgress: file, taskStatus: 'running' })!;
    expect(model.logs).toEqual(['starting research', 'found sources']);
    expect(model.groups[0].detail).toBe('parallel web search');
    // 运行中(非终态)不做 agent 字段回填,state 保持 entries 原样
    expect(model.groups[0].agents[0].state).toBe('running');
  });

  it('无文件时 logs 为空数组、detail 缺失', () => {
    const entries: WorkflowProgressEntry[] = [
      phaseEntry(0, 'P'),
      agentEntry(1, { agentId: 'a1', label: 'w', phaseTitle: 'P', state: 'done' }),
    ];
    const model = buildWorkflowTreeModel({ entries, taskStatus: 'running' })!;
    expect(model.logs).toEqual([]);
    expect(model.groups[0].detail).toBeUndefined();
  });

  it('任务终态时按 label+phaseTitle 从文件回填 resultPreview/durationMs/error(只补缺不覆盖,撞名取首个)', () => {
    const entries: WorkflowProgressEntry[] = [
      phaseEntry(0, 'P'),
      // 缺 resultPreview/durationMs → 应回填
      agentEntry(1, { agentId: 'a1', label: 'w', phaseTitle: 'P', state: 'done' }),
      // entries 已有 resultPreview → 不覆盖;durationMs 仍回填
      agentEntry(2, {
        agentId: 'a2',
        label: 'v',
        phaseTitle: 'P',
        state: 'done',
        resultPreview: 'from entries',
      }),
    ];
    const file = fileProgress({
      status: 'completed',
      agents: [
        // 与 a1 同 label+phaseTitle 的两条 → 取首个
        fileAgent({ label: 'w', phaseTitle: 'P', state: 'done', resultPreview: 'first', durationMs: 1000 }),
        fileAgent({ label: 'w', phaseTitle: 'P', state: 'done', resultPreview: 'second', durationMs: 2000 }),
        fileAgent({ label: 'v', phaseTitle: 'P', state: 'done', resultPreview: 'from file', durationMs: 3000 }),
        // label 相同但 phaseTitle 不同 → 不得匹配
        fileAgent({ label: 'w', phaseTitle: 'Other', state: 'failed', error: 'wrong phase' }),
      ],
    });
    const model = buildWorkflowTreeModel({ entries, fileProgress: file, taskStatus: 'completed' })!;
    const [a1, a2] = model.groups[0].agents;
    expect(a1.resultPreview).toBe('first');
    expect(a1.durationMs).toBe(1000);
    expect(a1.error).toBeUndefined();
    expect(a2.resultPreview).toBe('from entries');
    expect(a2.durationMs).toBe(3000);
  });

  it('任务非终态时不做文件字段回填', () => {
    const entries: WorkflowProgressEntry[] = [
      phaseEntry(0, 'P'),
      agentEntry(1, { agentId: 'a1', label: 'w', phaseTitle: 'P', state: 'done' }),
    ];
    const file = fileProgress({
      agents: [fileAgent({ label: 'w', phaseTitle: 'P', resultPreview: 'r', durationMs: 500 })],
    });
    const model = buildWorkflowTreeModel({ entries, fileProgress: file, taskStatus: 'running' })!;
    expect(model.groups[0].agents[0].resultPreview).toBeUndefined();
    expect(model.groups[0].agents[0].durationMs).toBeUndefined();
  });

  it('终态修正:任务终态而 agent 仍呈 start/progress/running/queued → state 改 error,error 字段留空', () => {
    const entries: WorkflowProgressEntry[] = [
      agentEntry(0, { agentId: 'a1', label: 'l1', state: 'start' }),
      agentEntry(1, { agentId: 'a2', label: 'l2', state: 'progress' }),
      agentEntry(2, { agentId: 'a3', label: 'l3', state: 'running' }),
      agentEntry(3, { agentId: 'a4', label: 'l4', state: 'queued' }),
      agentEntry(4, { agentId: 'a5', label: 'l5', state: 'done' }),
      agentEntry(5, { agentId: 'a6', label: 'l6', state: 'failed', error: 'real error' }),
    ];
    const model = buildWorkflowTreeModel({ entries, taskStatus: 'stopped' })!;
    const rows = model.groups[0].agents;
    for (const key of ['a1', 'a2', 'a3', 'a4']) {
      const row = rows.find((r) => r.key === key)!;
      expect(row.state).toBe('error');
      expect(row.error).toBeUndefined();
    }
    expect(rows.find((r) => r.key === 'a5')!.state).toBe('done');
    expect(rows.find((r) => r.key === 'a6')).toMatchObject({ state: 'failed', error: 'real error' });
  });

  it('终态修正同样作用于 file-only 路径', () => {
    const file = fileProgress({
      status: 'failed',
      agents: [
        fileAgent({ label: 'x', agentId: 'fx', state: 'running' }),
        fileAgent({ label: 'y', agentId: 'fy', state: 'stopped' }),
      ],
    });
    const model = buildWorkflowTreeModel({ fileProgress: file, taskStatus: 'failed' })!;
    expect(model.groups[0].agents.find((r) => r.key === 'fx')!.state).toBe('error');
    // stopped 是终态,不修正
    expect(model.groups[0].agents.find((r) => r.key === 'fy')!.state).toBe('stopped');
  });

  it('任务运行中不做终态修正', () => {
    const entries: WorkflowProgressEntry[] = [
      agentEntry(0, { agentId: 'a1', label: 'l1', state: 'progress' }),
    ];
    const model = buildWorkflowTreeModel({ entries, taskStatus: 'running' })!;
    expect(model.groups[0].agents[0].state).toBe('progress');
  });

  it('aggregate:totalTokens/totalToolCalls/durationMs 文件优先,缺失回退 usage', () => {
    const entries: WorkflowProgressEntry[] = [
      agentEntry(0, { agentId: 'a1', label: 'l1', state: 'running' }),
    ];
    const usage = { totalTokens: 111, toolUses: 22, durationMs: 3333 };
    const withFile = buildWorkflowTreeModel({
      entries,
      fileProgress: fileProgress({ totalTokens: 999, totalToolCalls: 88, durationMs: 7777 }),
      taskStatus: 'running',
      usage,
    })!;
    expect(withFile.aggregate).toMatchObject({ totalTokens: 999, totalToolCalls: 88, durationMs: 7777 });

    const withoutFile = buildWorkflowTreeModel({ entries, taskStatus: 'running', usage })!;
    expect(withoutFile.aggregate).toMatchObject({ totalTokens: 111, totalToolCalls: 22, durationMs: 3333 });

    // 文件在场但字段缺失 → 逐字段回退 usage
    const partialFile = buildWorkflowTreeModel({
      entries,
      fileProgress: fileProgress({ totalTokens: 999 }),
      taskStatus: 'running',
      usage,
    })!;
    expect(partialFile.aggregate).toMatchObject({ totalTokens: 999, totalToolCalls: 22, durationMs: 3333 });
  });

  it('aggregate.status:文件终态优先;文件非终态用 taskStatus', () => {
    const entries: WorkflowProgressEntry[] = [
      agentEntry(0, { agentId: 'a1', label: 'l1', state: 'done' }),
    ];
    // 文件已有终态结论(killed)→ 覆盖 taskStatus
    const terminalFile = buildWorkflowTreeModel({
      entries,
      fileProgress: fileProgress({ status: 'killed' }),
      taskStatus: 'stopped',
    })!;
    expect(terminalFile.aggregate.status).toBe('killed');

    // 文件还是 running(记录滞后)→ 用 taskStatus
    const staleFile = buildWorkflowTreeModel({
      entries,
      fileProgress: fileProgress({ status: 'running' }),
      taskStatus: 'completed',
    })!;
    expect(staleFile.aggregate.status).toBe('completed');

    // 无文件 → taskStatus
    const noFile = buildWorkflowTreeModel({ entries, taskStatus: 'running' })!;
    expect(noFile.aggregate.status).toBe('running');
  });

  it('aggregate.agentCount:file.agentCount 与实时行数取大;文件缺失取行数', () => {
    const entries: WorkflowProgressEntry[] = [
      agentEntry(0, { agentId: 'a1', label: 'l1', state: 'running' }),
      agentEntry(1, { agentId: 'a2', label: 'l2', state: 'running' }),
    ];
    const withCount = buildWorkflowTreeModel({
      entries,
      fileProgress: fileProgress({ agentCount: 7 }),
      taskStatus: 'running',
    })!;
    expect(withCount.aggregate.agentCount).toBe(7);

    // 运行期文件快照滞后(agentCount 还是 0 而实时行已 spawn)→ 不得盖过行数。
    const staleFile = buildWorkflowTreeModel({
      entries,
      fileProgress: fileProgress({ agentCount: 0 }),
      taskStatus: 'running',
    })!;
    expect(staleFile.aggregate.agentCount).toBe(2);

    const withoutCount = buildWorkflowTreeModel({ entries, taskStatus: 'running' })!;
    expect(withoutCount.aggregate.agentCount).toBe(2);
  });

  it('entries 的 state 缺失按 queued 处理,任务终态时同样被修正为 error', () => {
    const entries: WorkflowProgressEntry[] = [
      agentEntry(0, { agentId: 'a1', label: 'l1' }),
    ];
    const running = buildWorkflowTreeModel({ entries, taskStatus: 'running' })!;
    expect(running.groups[0].agents[0].state).toBe('queued');
    const done = buildWorkflowTreeModel({ entries, taskStatus: 'completed' })!;
    expect(done.groups[0].agents[0].state).toBe('error');
  });

  it("终态修正覆盖 'pending'(词表防御:UI 侧把 pending 当等待态,同一集合)", () => {
    const entries: WorkflowProgressEntry[] = [
      agentEntry(0, { agentId: 'a1', label: 'l1', state: 'pending' }),
    ];
    const model = buildWorkflowTreeModel({ entries, taskStatus: 'completed' })!;
    expect(model.groups[0].agents[0].state).toBe('error');
  });

  it('终态时事件流断在非终态而文件已有终态结论 → 采纳文件 state,不误标 error', () => {
    const entries: WorkflowProgressEntry[] = [
      // 事件流丢了收尾帧:a1 停在 progress,a2 停在 running
      agentEntry(0, { agentId: 'a1', label: 'alpha', phaseTitle: 'P', state: 'progress' }),
      agentEntry(1, { agentId: 'a2', label: 'beta', phaseTitle: 'P', state: 'running' }),
      phaseEntry(2, 'P'),
    ];
    const file = fileProgress({
      status: 'completed',
      agents: [
        fileAgent({ label: 'alpha', phaseTitle: 'P', state: 'done', resultPreview: 'ok' }),
        // beta 在文件里也没收口 → 仍走终态修正
        fileAgent({ label: 'beta', phaseTitle: 'P', state: 'running' }),
      ],
    });
    const model = buildWorkflowTreeModel({ entries, fileProgress: file, taskStatus: 'completed' })!;
    const rows = model.groups[0].agents;
    expect(rows.find((r) => r.key === 'a1')).toMatchObject({ state: 'done', resultPreview: 'ok' });
    expect(rows.find((r) => r.key === 'a2')!.state).toBe('error');
  });

  it('taskStatus 停在 running 而文件已终态(掉线丢终态通知)→ 同样触发回填与终态修正', () => {
    // 终态判定必须与 aggregate.status 同源:否则头部显示 done,行却永远转圈。
    const entries: WorkflowProgressEntry[] = [
      phaseEntry(0, 'P'),
      agentEntry(1, { agentId: 'a1', label: 'alpha', phaseTitle: 'P', state: 'progress' }),
      agentEntry(2, { agentId: 'a2', label: 'beta', phaseTitle: 'P', state: 'running' }),
    ];
    const file = fileProgress({
      status: 'completed',
      agents: [
        fileAgent({ label: 'alpha', phaseTitle: 'P', state: 'done', resultPreview: 'ok' }),
        fileAgent({ label: 'beta', phaseTitle: 'P', state: 'running' }),
      ],
    });
    const model = buildWorkflowTreeModel({ entries, fileProgress: file, taskStatus: 'running' })!;
    expect(model.aggregate.status).toBe('completed');
    const rows = model.groups[0].agents;
    expect(rows.find((r) => r.key === 'a1')).toMatchObject({ state: 'done', resultPreview: 'ok' });
    expect(rows.find((r) => r.key === 'a2')!.state).toBe('error');
  });

  it('只带 phaseIndex 的 agent 经 workflow_phase 的 index→title 映射归组,不坠入孤儿区', () => {
    const entries: WorkflowProgressEntry[] = [
      phaseEntry(0, 'Scan'),
      agentEntry(1, { agentId: 'a1', label: 'alpha', phaseIndex: 0, state: 'progress' }),
      // phaseIndex 对不上任何 phase 条目 → 仍走孤儿区,不误挂
      agentEntry(2, { agentId: 'a2', label: 'beta', phaseIndex: 9, state: 'progress' }),
    ];
    const model = buildWorkflowTreeModel({ entries, taskStatus: 'running' })!;
    expect(model.groups).toHaveLength(2);
    expect(model.groups[0]).toMatchObject({ title: 'Scan' });
    expect(model.groups[0].agents.map((r) => r.key)).toEqual(['a1']);
    expect(model.groups[1]).toMatchObject({ title: null });
    expect(model.groups[1].agents.map((r) => r.key)).toEqual(['a2']);
  });

  it('同 phase 同 label 的多 agent 按 agentId 精确回填,不再撞名共享首条', () => {
    // parallel 同 prompt 编队的 label 天然相同 —— agentId 才是行身份。
    const entries: WorkflowProgressEntry[] = [
      phaseEntry(0, 'P'),
      agentEntry(1, { agentId: 'a1', label: 'verify', phaseTitle: 'P', state: 'done' }),
      agentEntry(2, { agentId: 'a2', label: 'verify', phaseTitle: 'P', state: 'done' }),
    ];
    const file = fileProgress({
      status: 'completed',
      agents: [
        fileAgent({ agentId: 'a1', label: 'verify', phaseTitle: 'P', state: 'done', resultPreview: 'first ok', durationMs: 100 }),
        fileAgent({ agentId: 'a2', label: 'verify', phaseTitle: 'P', state: 'done', resultPreview: 'second ok', durationMs: 200 }),
      ],
    });
    const model = buildWorkflowTreeModel({ entries, fileProgress: file, taskStatus: 'completed' })!;
    const rows = model.groups[0].agents;
    expect(rows.find((r) => r.key === 'a1')).toMatchObject({ resultPreview: 'first ok', durationMs: 100 });
    expect(rows.find((r) => r.key === 'a2')).toMatchObject({ resultPreview: 'second ok', durationMs: 200 });
  });

  it('file-only 路径:只带 phaseIndex 的文件行经顶层 phases[] 反查归组,不坠孤儿区', () => {
    const file = fileProgress({
      phases: [{ index: 0, title: 'Scan' }],
      agents: [
        fileAgent({ label: 'queued-one', agentId: '', state: 'queued', phaseIndex: 0 }),
        fileAgent({ label: 'lost', agentId: '', state: 'queued', phaseIndex: 9 }),
      ],
    });
    const model = buildWorkflowTreeModel({ fileProgress: file, taskStatus: 'running' })!;
    expect(model.groups[0]).toMatchObject({ title: 'Scan' });
    expect(model.groups[0].agents.map((r) => r.label)).toEqual(['queued-one']);
    expect(model.groups[1]).toMatchObject({ title: null });
    expect(model.groups[1].agents.map((r) => r.label)).toEqual(['lost']);
  });

  it('entries 已有终态 state 时文件不覆盖(采纳只发生在事件流停在非终态时)', () => {
    const entries: WorkflowProgressEntry[] = [
      agentEntry(0, { agentId: 'a1', label: 'alpha', phaseTitle: 'P', state: 'error', error: 'boom' }),
      phaseEntry(1, 'P'),
    ];
    const file = fileProgress({
      status: 'completed',
      agents: [fileAgent({ label: 'alpha', phaseTitle: 'P', state: 'done' })],
    });
    const model = buildWorkflowTreeModel({ entries, fileProgress: file, taskStatus: 'completed' })!;
    expect(model.groups[0].agents[0]).toMatchObject({ state: 'error', error: 'boom' });
  });
});

describe('isTerminalWorkflowFileStatus(文件快照收口判定)', () => {
  it('终态词表命中为 true,运行中/等待/未知/缺失为 false', async () => {
    const { isTerminalWorkflowFileStatus } = await import('../workflowProgressModel');
    for (const s of ['completed', 'failed', 'stopped', 'killed', 'done', 'error']) {
      expect(isTerminalWorkflowFileStatus(s)).toBe(true);
    }
    for (const s of ['running', 'queued', 'pending', 'mystery', undefined]) {
      expect(isTerminalWorkflowFileStatus(s)).toBe(false);
    }
  });
});

describe('workflowAgentVisualState(方块条视觉归一)', () => {
  it('两套词表归一到四色;未知词与 start 归 queued(宁少染不误染)', async () => {
    const { workflowAgentVisualState } = await import('../workflowProgressModel');
    expect(workflowAgentVisualState('done')).toBe('done');
    expect(workflowAgentVisualState('completed')).toBe('done');
    expect(workflowAgentVisualState('running')).toBe('running');
    expect(workflowAgentVisualState('progress')).toBe('running');
    expect(workflowAgentVisualState('error')).toBe('failed');
    expect(workflowAgentVisualState('failed')).toBe('failed');
    expect(workflowAgentVisualState('stopped')).toBe('failed');
    expect(workflowAgentVisualState('killed')).toBe('failed');
    expect(workflowAgentVisualState('start')).toBe('queued');
    expect(workflowAgentVisualState('queued')).toBe('queued');
    expect(workflowAgentVisualState('pending')).toBe('queued');
    expect(workflowAgentVisualState('mystery-state')).toBe('queued');
    expect(workflowAgentVisualState(undefined)).toBe('queued');
  });
});
