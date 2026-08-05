import { describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost';
import {
  GHOST_PLAN_RATE_MAX_UPDATES,
  GhostPlanSlot,
} from '../planSlot';

const trustedContext = {
  sessionId: 'session-current',
  sessionInstanceId: 'instance-current',
} as const;

function ghost(slots: InstalledGhost['manifest']['slots'] = ['plan']): InstalledGhost {
  return {
    dir: '/ghost',
    enabled: true,
    manifest: {
      schemaVersion: 2,
      id: 'planner',
      name: 'Planner',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots,
    },
  } as InstalledGhost;
}

function harness(options: {
  slots?: InstalledGhost['manifest']['slots'];
  context?: typeof trustedContext | null;
  trusted?: boolean;
} = {}) {
  const projector = vi.fn(async () => {});
  const slot = new GhostPlanSlot({
    getGhost: () => ghost(options.slots),
    getCurrentSessionContext: () =>
      options.context === undefined ? trustedContext : options.context,
    isTrustedSessionContext: () => options.trusted ?? true,
    projector,
  });
  return { slot, projector };
}

const valid = {
  type: 'plan-update',
  explanation: '开始实现',
  plan: [
    { step: '调查', status: 'completed' },
    { step: '实现', status: 'in_progress' },
    { step: '测试', status: 'pending' },
  ],
} as const;

describe('GhostPlanSlot', () => {
  it('把合法 plan-update 投影到 Host 当前可信任务', async () => {
    const { slot, projector } = harness();
    await expect(slot.handleUpdate('planner', valid)).resolves.toEqual({ ok: true });
    expect(projector).toHaveBeenCalledWith(trustedContext, {
      explanation: valid.explanation,
      plan: valid.plan,
    });
  });

  it.each([
    [{ type: 'plan-update' }, 'plan 必须是非空数组'],
    [{ type: 'plan-update', plan: [] }, 'plan 必须是非空数组'],
    [{ type: 'plan-update', plan: [{ step: '实现', status: 'running' }] }, 'status'],
  ])('拒绝非法 payload %#', async (payload, message) => {
    const { slot, projector } = harness();
    const result = await slot.handleUpdate('planner', payload);
    expect(result).toMatchObject({ ok: false, errorCode: 'INVALID_PARAMS' });
    if (!result.ok) expect(result.message).toContain(message);
    expect(projector).not.toHaveBeenCalled();
  });

  it('未声明 plan capability 时拒绝', async () => {
    const { slot, projector } = harness({ slots: ['tool'] });
    await expect(slot.handleUpdate('planner', valid)).resolves.toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
    expect(projector).not.toHaveBeenCalled();
  });

  it.each([null, trustedContext])('缺少可信 session context 时拒绝 (%s)', async (context) => {
    const { slot, projector } = harness({
      context,
      trusted: context === null,
    });
    await expect(slot.handleUpdate('planner', valid)).resolves.toMatchObject({
      ok: false,
      errorCode: 'NO_SESSION_CONTEXT',
    });
    expect(projector).not.toHaveBeenCalled();
  });

  it('会话在异步验身期间切换时 fail closed', async () => {
    let current = { sessionId: 'session-before', sessionInstanceId: 'instance-before' };
    const projector = vi.fn(async () => {});
    const slot = new GhostPlanSlot({
      getGhost: () => ghost(),
      getCurrentSessionContext: () => current,
      isTrustedSessionContext: async () => {
        current = { sessionId: 'session-after', sessionInstanceId: 'instance-after' };
        return true;
      },
      projector,
    });
    await expect(slot.handleUpdate('planner', valid)).resolves.toMatchObject({
      ok: false,
      errorCode: 'NO_SESSION_CONTEXT',
    });
    expect(projector).not.toHaveBeenCalled();
  });

  it('拒绝插件伪造 sessionId，且不会投影到伪造目标', async () => {
    const { slot, projector } = harness();
    await expect(slot.handleUpdate('planner', { ...valid, sessionId: 'session-forged' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_PARAMS',
    });
    expect(projector).not.toHaveBeenCalled();
  });

  it('多次同步每次都提交完整 Plan，后一次由同一投影入口替换前一次', async () => {
    const { slot, projector } = harness();
    await slot.handleUpdate('planner', valid);
    const replacement = {
      type: 'plan-update',
      plan: [{ step: '全部完成', status: 'completed' }],
    } as const;
    await slot.handleUpdate('planner', replacement);

    expect(projector).toHaveBeenNthCalledWith(1, trustedContext, {
      explanation: valid.explanation,
      plan: valid.plan,
    });
    expect(projector).toHaveBeenNthCalledWith(2, trustedContext, {
      plan: replacement.plan,
    });
  });

  it('全 completed 的完整 Plan 正常投影为成功', async () => {
    const { slot, projector } = harness();
    const completed = {
      type: 'plan-update',
      plan: [
        { step: '实现', status: 'completed' },
        { step: '测试', status: 'completed' },
      ],
    } as const;
    await expect(slot.handleUpdate('planner', completed)).resolves.toEqual({ ok: true });
    expect(projector).toHaveBeenCalledWith(trustedContext, { plan: completed.plan });
  });

  it('限制单个 Ghost 紧循环更新 Plan', async () => {
    let now = 1_000;
    const projector = vi.fn(async () => {});
    const isTrustedSessionContext = vi.fn(() => true);
    const slot = new GhostPlanSlot({
      getGhost: () => ghost(),
      getCurrentSessionContext: () => trustedContext,
      isTrustedSessionContext,
      projector,
      now: () => now,
    });
    for (let index = 0; index < GHOST_PLAN_RATE_MAX_UPDATES; index += 1) {
      await expect(slot.handleUpdate('planner', valid)).resolves.toEqual({ ok: true });
    }
    await expect(slot.handleUpdate('planner', valid)).resolves.toMatchObject({
      ok: false,
      errorCode: 'RATE_LIMITED',
    });
    expect(isTrustedSessionContext).toHaveBeenCalledTimes(GHOST_PLAN_RATE_MAX_UPDATES);
    expect(projector).toHaveBeenCalledTimes(GHOST_PLAN_RATE_MAX_UPDATES);
    now += 1_000;
    await expect(slot.handleUpdate('planner', valid)).resolves.toEqual({ ok: true });
  });
});
