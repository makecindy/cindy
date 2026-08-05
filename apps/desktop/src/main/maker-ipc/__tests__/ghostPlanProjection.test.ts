import { describe, expect, it } from 'vitest';

import { extractPlanTodos } from '@cindy/maker-shared/message-render';

import {
  buildGhostPlanProjectionEvent,
  GHOST_PLAN_TOOL_USE_ID,
} from '../ghostPlanProjection';

describe('Ghost Plan → Codex Plan UI projection', () => {
  it('构造既有 update_plan tool_use 事件并沿用 in_progress 语义', () => {
    const update = {
      explanation: '开始实现',
      plan: [
        { step: '调查', status: 'completed' as const },
        { step: '实现', status: 'in_progress' as const },
        { step: '测试', status: 'pending' as const },
      ],
    };
    const event = buildGhostPlanProjectionEvent(update);
    expect(event).toMatchObject({
      type: 'tool_use',
      source: 'codex',
      data: {
        toolUseId: GHOST_PLAN_TOOL_USE_ID,
        toolName: 'update_plan',
        input: update,
      },
    });
    expect(extractPlanTodos('update_plan', update)).toEqual([
      { content: '调查', status: 'completed' },
      { content: '实现', status: 'in_progress' },
      { content: '测试', status: 'pending' },
    ]);
  });

  it('多次完整同步复用同一 session-scoped toolUseId，后一次覆盖且支持完成态', () => {
    const first = buildGhostPlanProjectionEvent({
      plan: [{ step: '实现', status: 'in_progress' }],
    });
    const second = buildGhostPlanProjectionEvent({
      plan: [{ step: '实现', status: 'completed' }],
    });
    expect(first.data).toMatchObject({ toolUseId: GHOST_PLAN_TOOL_USE_ID });
    expect(second.data).toEqual({
      toolUseId: GHOST_PLAN_TOOL_USE_ID,
      toolName: 'update_plan',
      input: { plan: [{ step: '实现', status: 'completed' }] },
    });
    expect(extractPlanTodos('update_plan', second.data.input)).toEqual([
      { content: '实现', status: 'completed' },
    ]);
  });
});
