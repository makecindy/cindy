import { describe, expect, it } from 'vitest';
import { applyCodexPlanSnapshotOnDone, markCodexPlanTurnFailed } from '../messageRender.js';

function planMessage(id: string, plan: unknown) {
  return {
    id,
    clientId: id,
    role: 'tool_use',
    toolName: 'update_plan',
    toolUseId: id,
    toolInput: { explanation: 'keep', plan },
    content: {
      toolUseId: id,
      toolName: 'update_plan',
      input: { explanation: 'keep', plan },
    },
  };
}

describe('applyCodexPlanSnapshotOnDone', () => {
  it('applies the terminal snapshot only to the matching turn plan row', () => {
    const older = planMessage('plan:old', [{ step: 'Old', status: 'in_progress' }]);
    const latest = planMessage('plan:new', [
      { step: 'Inspect', status: 'completed' },
      { step: 'Patch', status: 'in_progress' },
    ]);
    const snapshot = [
      { step: 'Inspect', status: 'completed' },
      { step: 'Patch', status: 'completed' },
    ];

    const result = applyCodexPlanSnapshotOnDone([older, latest], snapshot, 'new');

    expect(result).toMatchObject({ changed: true, toolUseId: 'plan:new' });
    expect(result.messages[0]).toBe(older);
    expect(result.messages[1]).toMatchObject({
      toolInput: { explanation: 'keep', plan: snapshot },
      content: { input: { explanation: 'keep', plan: snapshot } },
    });
  });

  it('does not update an earlier turn when the matching plan row is missing', () => {
    const old = planMessage('plan:old', [{ step: 'Old', status: 'in_progress' }]);
    const messages = [old];

    expect(applyCodexPlanSnapshotOnDone(
      messages,
      [{ step: 'New', status: 'completed' }],
      'new',
    )).toEqual({ messages, changed: false, toolUseId: null });
  });

  it('is idempotent across all snapshot fields', () => {
    const snapshot = [{ step: 'Done', status: 'completed', description: 'final details' }];
    const message = planMessage('plan:done', snapshot);
    const messages = [message];

    expect(applyCodexPlanSnapshotOnDone(messages, snapshot, 'done')).toEqual({
      messages,
      changed: false,
      toolUseId: 'plan:done',
    });
    expect(applyCodexPlanSnapshotOnDone(
      messages,
      [{ step: 'Done', status: 'completed', description: 'updated details' }],
      'done',
    ).changed).toBe(true);
  });

  it('applies an authoritative empty terminal snapshot', () => {
    const message = planMessage('plan:old', [{ step: 'Old', status: 'in_progress' }]);
    const result = applyCodexPlanSnapshotOnDone([message], [], 'old');

    expect(result.changed).toBe(true);
    expect(result.messages[0]).toMatchObject({
      toolInput: { plan: [] },
      content: { input: { plan: [] } },
    });
  });

  it('does nothing when task_complete has no plan snapshot', () => {
    const message = planMessage('plan:old', [{ step: 'Old', status: 'in_progress' }]);
    const messages = [message];

    expect(applyCodexPlanSnapshotOnDone(messages, null, 'old')).toEqual({
      messages,
      changed: false,
      toolUseId: null,
    });
  });

  it('seals the matching plan on a successful turn without ticking its open steps', () => {
    const completedAtMs = 1_700_000_005_000;
    const openSteps = [
      { step: 'Inspect', status: 'in_progress' },
      { step: 'Patch', status: 'pending' },
    ];
    const message = planMessage('plan:done', openSteps);
    const result = applyCodexPlanSnapshotOnDone(
      [message],
      null,
      'done',
      'completed',
      completedAtMs,
    );

    expect(result.changed).toBe(true);
    expect(result.toolUseId).toBe('plan:done');
    // 章封生命周期,步骤事实保持原样:agent 没报告完成的事不能替它宣布完成。
    expect(result.messages[0]).toMatchObject({
      terminalPlanSnapshot: true,
      planUpdatedAtMs: completedAtMs,
      toolInput: { plan: openSteps },
      content: { input: { plan: openSteps } },
    });
  });

  it('seals an already-sealed row only once so the capsule grace does not restart', () => {
    const message = {
      ...planMessage('plan:done', [{ step: 'Inspect', status: 'in_progress' }]),
      terminalPlanSnapshot: true,
    };
    const messages = [message];

    expect(applyCodexPlanSnapshotOnDone(messages, null, 'done', 'completed')).toEqual({
      messages,
      changed: false,
      toolUseId: 'plan:done',
    });
  });

  it('applies an explicit unfinished snapshot verbatim and seals it', () => {
    const message = planMessage('plan:done', [
      { step: 'Inspect', status: 'in_progress' },
      { step: 'Patch', status: 'pending' },
    ]);
    const reportedProgress = [
      { step: 'Inspect', status: 'completed', description: 'kept from latest update' },
      { step: 'Patch', status: 'in_progress' },
    ];

    const result = applyCodexPlanSnapshotOnDone(
      [message],
      reportedProgress,
      'done',
      'completed',
    );

    expect(result.changed).toBe(true);
    expect(result.messages[0]).toMatchObject({
      terminalPlanSnapshot: true,
      toolInput: { plan: reportedProgress },
    });
  });

  it('does not seal without a matching turn id', () => {
    const message = planMessage('plan:unrelated', [
      { step: 'Inspect', status: 'in_progress' },
    ]);
    const messages = [message];

    expect(applyCodexPlanSnapshotOnDone(
      messages,
      null,
      null,
      'completed',
    )).toEqual({ messages, changed: false, toolUseId: null });
  });

  it('lets the cancelled flag outrank raw.status completed', () => {
    // done 可同时带 cancelled:true + raw.status 'completed'(用户 Stop 恰逢
    // turn 自然收尾)。main 的 isSuccessfulCodexDoneEventData 让取消优先、按
    // 非成功持久化;渲染端必须同序——只看 status 就会即时盖章退场,随后落库
    // 行广播又把计划复活,即时 UI 与 DB 分叉。
    const message = planMessage('plan:raced', [{ step: 'Inspect', status: 'in_progress' }]);
    const messages = [message];

    const result = applyCodexPlanSnapshotOnDone(
      messages,
      null,
      'raced',
      'completed',
      undefined,
      true,
    );
    // 不盖成功章,但要立即落失败印记(turnCompleted:false)——只拦盖章的话,
    // 全勾完的取消计划会被旧数据兜底即时隐藏,再被 main 落库行复活闪回。
    expect(result.changed).toBe(true);
    expect(result.toolUseId).toBe('plan:raced');
    expect(result.messages[0]).toMatchObject({ turnCompleted: false });
    expect(result.messages[0]).not.toMatchObject({ terminalPlanSnapshot: true });
  });

  it('does not seal a failed or interrupted turn, but stamps it as failed', () => {
    // interrupted / failed 的 done 不盖章(任务还活着,计划必须留在屏幕上),
    // 但要立即在内存补 turnCompleted:false——main 的落库印记在 done 广播之后
    // 才异步到达,没有这枚即时印记,全勾完的中断计划会先被旧数据兜底隐藏、
    // 再被落库行广播复活闪回。
    const message = planMessage('plan:stopped', [{ step: 'Inspect', status: 'in_progress' }]);
    const result = applyCodexPlanSnapshotOnDone([message], null, 'stopped', 'interrupted');

    expect(result.changed).toBe(true);
    expect(result.toolUseId).toBe('plan:stopped');
    expect(result.messages[0]).toMatchObject({
      turnCompleted: false,
      // 不盖章,步骤状态不动。
      toolInput: { explanation: 'keep', plan: [{ step: 'Inspect', status: 'in_progress' }] },
    });
    expect(result.messages[0]).not.toHaveProperty('terminalPlanSnapshot');

    // 已有印记时是纯 no-op,不重启胶囊计时。
    const stamped = { ...message, turnCompleted: false };
    expect(applyCodexPlanSnapshotOnDone([stamped], null, 'stopped', 'interrupted')).toEqual({
      messages: [stamped],
      changed: false,
      toolUseId: 'plan:stopped',
    });
  });
});

describe('markCodexPlanTurnFailed', () => {
  // 没有 done 的终态 error:该 turn 永远等不到章。renderer 在 error 边界给最近
  // 一条未盖章的计划行补 turnCompleted:false,面板据此把它当存活任务。
  it('stamps the latest unsealed plan row as failed without touching steps', () => {
    const plan = planMessage('plan:err', [{ step: 'Ship', status: 'completed' }]);
    const result = markCodexPlanTurnFailed([plan]);

    expect(result.changed).toBe(true);
    expect(result.messages[0]).toMatchObject({
      turnCompleted: false,
      toolInput: { plan: [{ step: 'Ship', status: 'completed' }] },
    });
    // 印记同时落 content,并回传 toolUseId:mobile 靠这两样把同一份 content 写回
    // live-plan 缓存,否则 overlay 会把落库印记盖回去(review P1)。
    expect(result.toolUseId).toBe('plan:err');
    expect(result.messages[0].content).toMatchObject({ turnCompleted: false });
  });

  it('leaves sealed or already-stamped rows and plan-less turns alone', () => {
    const sealed = { ...planMessage('plan:done', []), terminalPlanSnapshot: true };
    expect(markCodexPlanTurnFailed([sealed])).toEqual({ messages: [sealed], changed: false, toolUseId: null });

    const stamped = { ...planMessage('plan:old-fail', []), turnCompleted: false };
    expect(markCodexPlanTurnFailed([stamped])).toEqual({ messages: [stamped], changed: false, toolUseId: null });

    const noPlan = { role: 'tool_use' as const, clientId: 'b1', toolName: 'Bash', content: '' };
    expect(markCodexPlanTurnFailed([noPlan])).toEqual({ messages: [noPlan], changed: false, toolUseId: null });
  });

  it('writes the lifecycle stamp into content as well for mobile live-plan overlays', () => {
    // mobile 的 live-plan 缓存只保存 content,overlay 会用缓存覆盖 main 广播的
    // 持久化 content。章/失败印记必须同时落在 content 里,否则 overlay 一盖,
    // 成功计划在手机端永远"未盖章",下一 turn 把上一轮吞进同一 session。
    const message = planMessage('plan:done', [{ step: 'Ship', status: 'completed' }]);
    const sealed = applyCodexPlanSnapshotOnDone([message], null, 'done', 'completed', 1_700);
    expect(sealed.messages[0].content).toMatchObject({
      terminalPlanSnapshot: true,
      terminalPlanAtMs: 1_700,
    });

    const interrupted = applyCodexPlanSnapshotOnDone(
      [planMessage('plan:stop', [{ step: 'Ship', status: 'completed' }])],
      null,
      'plan:stop'.replace('plan:', ''),
      'interrupted',
    );
    expect(interrupted.messages[0].content).toMatchObject({ turnCompleted: false });
  });

  it('does not stop the failure scan at a mid-turn steer interjection', () => {
    // steer 插话不开新 turn:同一 vendor turn 里 计划 → steer user 行 → 终态
    // error 的序列,回扫必须穿过 steer 行命中所属计划;普通 user 行仍是硬边界。
    const plan = planMessage('plan:cur', [{ step: 'Ship', status: 'completed' }]);
    const steerRow = { role: 'user' as const, clientId: 'u-steer', content: 'wait', delivery: 'steer' };

    const result = markCodexPlanTurnFailed([plan, steerRow]);
    expect(result.changed).toBe(true);
    expect(result.messages[0]).toMatchObject({ turnCompleted: false });
  });

  it('never reaches past the latest user message into an older turn plan', () => {
    // 所有权边界:本次失败的 turn 没发过 update_plan 时,不得把上一段历史里
    // 未盖章的旧计划(如升级前已全勾完退场的行)标成失败复活——main 侧对应
    // 落库也不会发生,内存里这枚错印记将没有任何广播能纠正。
    const historicPlan = planMessage('plan:old', [{ step: 'Ship', status: 'completed' }]);
    const newUserTurn = { role: 'user' as const, clientId: 'u2', content: 'next task' };
    const failingTool = { role: 'tool_use' as const, clientId: 'b2', toolName: 'Bash', content: '' };

    expect(markCodexPlanTurnFailed([historicPlan, newUserTurn, failingTool])).toEqual({
      messages: [historicPlan, newUserTurn, failingTool],
      changed: false,
      toolUseId: null,
    });

    // 计划在当前 user 段内(属于本次失败 turn)时照常落印。
    const currentPlan = planMessage('plan:cur', [{ step: 'Ship', status: 'completed' }]);
    const result = markCodexPlanTurnFailed([newUserTurn, currentPlan]);
    expect(result.changed).toBe(true);
    expect(result.messages[1]).toMatchObject({ turnCompleted: false });
  });
});
