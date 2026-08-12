import { describe, expect, it } from 'vitest';

import {
  buildPlanReconcileNote,
  summarizeOpenPlan,
  type PlanReconcileCandidateRow,
} from '../planReconcile';

let seq = 0;
function row(
  role: string,
  content: unknown,
  clientId = `row-${(seq += 1)}`,
): PlanReconcileCandidateRow {
  return { clientId, role, content, createdAt: 1_700_000_000_000 + seq * 1000 };
}

function planRow(
  plan: Array<{ step: string; status: string }>,
  extra: Record<string, unknown> = {},
  toolUseId = `plan:turn-${(seq += 1)}`,
): PlanReconcileCandidateRow {
  return row('tool_use', {
    toolUseId,
    toolName: 'update_plan',
    input: { plan },
    ...extra,
  });
}

describe('summarizeOpenPlan', () => {
  it('returns open steps for an unsealed plan left behind', () => {
    const summary = summarizeOpenPlan([
      row('user', { text: '做点什么' }),
      planRow([
        { step: 'Done work', status: 'completed' },
        { step: 'Open work', status: 'in_progress' },
        { step: 'Future work', status: 'pending' },
      ]),
    ]);

    expect(summary).toEqual({
      openSteps: ['Open work', 'Future work'],
      totalSteps: 3,
    });
  });

  it('returns null when there is no plan at all', () => {
    expect(summarizeOpenPlan([row('user', { text: 'hi' })])).toBeNull();
  });

  it('returns null when the plan is fully completed', () => {
    expect(
      summarizeOpenPlan([
        planRow([
          { step: 'A', status: 'completed' },
          { step: 'B', status: 'completed' },
        ]),
      ]),
    ).toBeNull();
  });

  it('returns null when the plan was sealed by a successful turn', () => {
    // 成功收尾盖了章的清单不对账:它的生命周期已经结束,哪怕留有未勾步骤
    // 也是"如实记录",下一轮不需要 agent 交代。
    expect(
      summarizeOpenPlan([
        planRow(
          [
            { step: 'Done', status: 'completed' },
            { step: 'Left open', status: 'in_progress' },
          ],
          { terminalPlanSnapshot: true },
        ),
      ]),
    ).toBeNull();
  });

  it('ignores subagent plans (ownership boundary)', () => {
    expect(
      summarizeOpenPlan([
        row('tool_use', {
          toolUseId: 'todo-sub',
          toolName: 'TodoWrite',
          parentToolUseId: 'agent-task-1',
          input: { todos: [{ content: 'Subagent internal', status: 'in_progress' }] },
        }),
      ]),
    ).toBeNull();
  });

  it('still reconciles a top-level plan whose agent_meta carries a legacy transcript parent', () => {
    // legacy Claude 导入把 transcript 链边(非 RFC 串)存进 agent_meta.parentUuid。
    // 把裸字段一律提升成显式 parentToolUseId 会让它被判成子代理、顶层计划从对账里
    // 消失,还与保留裸字段的 mobile 分叉(review P2)。
    const legacyPlan: PlanReconcileCandidateRow = {
      ...planRow([{ step: 'Open work', status: 'in_progress' }]),
      agentMeta: { parentUuid: 'preceding-user-uuid' },
    };
    expect(summarizeOpenPlan([legacyPlan])).toEqual({
      openSteps: ['Open work'],
      totalSteps: 1,
    });

    // 真正的 SDK 子代理归属(toolu_ / call_ 形态)照旧过滤。
    const subagentPlan: PlanReconcileCandidateRow = {
      ...planRow([{ step: 'Subagent work', status: 'in_progress' }]),
      agentMeta: { parentUuid: 'toolu_01AbCdEf' },
    };
    expect(summarizeOpenPlan([subagentPlan])).toBeNull();
  });

  it('reconciles only the latest plan session after a user turn boundary', () => {
    const summary = summarizeOpenPlan([
      planRow([{ step: 'Old abandoned', status: 'in_progress' }]),
      row('user', { text: '换个话题' }),
      planRow([
        { step: 'Current work', status: 'in_progress' },
        { step: 'Current next', status: 'pending' },
      ]),
    ]);

    // 只对账当前(最新 session)的清单,不把上一轮被 supersede 的旧步骤翻出来。
    expect(summary?.openSteps).toEqual(['Current work', 'Current next']);
  });
});

  it('keeps a reconcile path for a fully-completed plan whose turn failed', () => {
    // turn 以失败/中断收尾时 main 打 turnCompleted:false,面板按设计不走全勾完
    // 兜底退场——这份全绿计划的唯一收口通道就是下一轮对账,不能因 openSteps
    // 为空而跳过。
    const summary = summarizeOpenPlan([
      planRow(
        [
          { step: 'Done A', status: 'completed' },
          { step: 'Done B', status: 'completed' },
        ],
        { turnCompleted: false },
      ),
    ]);

    expect(summary).toEqual({ openSteps: [], totalSteps: 2 });
    const note = buildPlanReconcileNote(summary!);
    expect(note).toContain('全部标记完成');
    expect(note).toContain('收口');
    expect(note).toContain('清掉');
    expect(note).toContain('以下是用户的新消息');
  });

  it('still skips a fully-completed plan without any failure stamp', () => {
    expect(
      summarizeOpenPlan([
        planRow([
          { step: 'A', status: 'completed' },
          { step: 'B', status: 'completed' },
        ]),
      ]),
    ).toBeNull();
  });

describe('buildPlanReconcileNote', () => {
  it('lists open steps and grants all three outcomes including deletion', () => {
    const note = buildPlanReconcileNote({
      openSteps: ['Fix parser', 'Run tests'],
      totalSteps: 4,
    });

    expect(note).toContain('- Fix parser');
    expect(note).toContain('- Run tests');
    // 三个出口都要在场:继续更新 / 修订 / 清掉。删除授权是关键——不给的话
    // 模型会把不相干的旧清单硬拖进新话题。
    expect(note).toContain('更新计划状态');
    expect(note).toContain('修订条目');
    expect(note).toContain('清掉');
    // 顺手性质,不许抢占用户问题。
    expect(note).toContain('不要让它先于用户的问题');
    expect(note).toContain('以下是用户的新消息');
  });

  it('clamps长步骤与步骤内换行,注入段大小与计划无关', () => {
    // 步骤内容由模型自由生成、无长度约束:原样注入会让一份异常(或被诱导生成的)
    // 计划显著占用下一轮上下文,极端情况把用户的真正问题挤过输入上限(review P2)。
    const note = buildPlanReconcileNote({
      openSteps: [`${'很长的步骤'.repeat(200)}\n第二行\n\n第三行`],
      totalSteps: 1,
    });
    const stepLine = note.split('\n').find((line) => line.startsWith('- '));
    expect(stepLine).toBeDefined();
    // 换行折成空格 → 清单结构不被撑散;整行长度有界。
    expect(stepLine!.length).toBeLessThanOrEqual(2 + 160 + 1);
    expect(stepLine!.endsWith('…')).toBe(true);
    expect(note.split('\n').filter((line) => line.startsWith('- ')).length).toBe(1);
  });

  it('caps the listed steps and notes the remainder', () => {
    const note = buildPlanReconcileNote({
      openSteps: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      totalSteps: 8,
    });

    expect(note).toContain('- f');
    expect(note).not.toContain('- g');
    expect(note).toContain('另有 2 项未列出');
  });
});
