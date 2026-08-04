/**
 * scheduleSlot.test — 自动化草稿槽(agent.schedule 加档)的假 deps 单测。
 *
 * 最重要的一条在文件末尾:**这个槽只能开面板,不能建任务**。它没有任何触达调度
 * 存储的依赖 —— 那条约束是本能力的全部安全性所依,必须被测试钉住,不能只靠注释。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  GHOST_SCHEDULE_DRAFT_MIN_INTERVAL_SUGGESTION_MS,
  GHOST_SCHEDULE_DRAFT_NAME_MAX_CHARS,
  GHOST_SCHEDULE_DRAFT_PROMPT_MAX_CHARS,
  type GhostScheduleDraftPush,
  type InstalledGhost,
} from '../../../shared/ghost';
import { GhostScheduleSlot, type ScheduleSlotDeps } from '../scheduleSlot';

function scheduleGhost(
  options: {
    slots?: string[];
    schedule?: boolean;
    enabled?: boolean;
    background?: boolean;
  } = {},
): InstalledGhost {
  const slots = options.slots ?? ['agent', 'tool'];
  const agentNeeds = {
    ...(options.background === true ? { background: true } : {}),
    ...(options.schedule !== false ? { schedule: true } : {}),
  };
  return {
    manifest: {
      schemaVersion: 2,
      id: 'sched-ghost',
      name: '签字门看板',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots,
      ...(Object.keys(agentNeeds).length > 0 ? { agent: agentNeeds } : {}),
    },
    dir: '/fake/sched-ghost',
    enabled: options.enabled ?? true,
    iconDataUrl: 'data:image/png;base64,AAAA',
  } as InstalledGhost;
}

function makeSlot(overrides: Partial<ScheduleSlotDeps> = {}) {
  let clock = 0;
  const pushes: GhostScheduleDraftPush[] = [];
  let seq = 0;
  const deps: ScheduleSlotDeps = {
    getGhost: () => scheduleGhost(),
    broadcast: vi.fn((payload: GhostScheduleDraftPush) => {
      pushes.push(payload);
      return true;
    }),
    // 每次调用推进一小时,默认不撞限速;测限速的用例自己注入固定时钟。
    now: () => (clock += 3_600_000),
    newRequestId: () => `req-${++seq}`,
    ...overrides,
  };
  return { slot: new GhostScheduleSlot(deps), deps, pushes };
}

const validReq = {
  name: 'Codex 重置提醒',
  prompt: '检查本机 Codex 重置时间,快到了就调 update_status 写回去。',
};

describe('GhostScheduleSlot 资格审', () => {
  it('声明了 agent 槽 + schedule:true 才放行', () => {
    const { slot, pushes } = makeSlot();
    expect(slot.handleRequest('sched-ghost', validReq)).toEqual({ ok: true });
    expect(pushes).toHaveLength(1);
  });

  it('未装 → PERMISSION_DENIED', () => {
    const { slot } = makeSlot({ getGhost: () => null });
    expect(slot.handleRequest('nope', validReq)).toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
  });

  it('已装但停用 → PERMISSION_DENIED', () => {
    const { slot } = makeSlot({ getGhost: () => scheduleGhost({ enabled: false }) });
    expect(slot.handleRequest('sched-ghost', validReq)).toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
  });

  it('有 agent 槽但没有 schedule 加档 → PERMISSION_DENIED(仅 background 不够)', () => {
    const { slot } = makeSlot({
      getGhost: () => scheduleGhost({ schedule: false, background: true }),
    });
    expect(slot.handleRequest('sched-ghost', validReq)).toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
  });

  it('写了 schedule 但 slots 没有 agent → PERMISSION_DENIED', () => {
    const { slot } = makeSlot({ getGhost: () => scheduleGhost({ slots: ['tool'] }) });
    expect(slot.handleRequest('sched-ghost', validReq)).toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
  });
});

describe('GhostScheduleSlot 载荷校验', () => {
  it.each([
    ['非对象载荷', 'nope'],
    ['缺 name', { prompt: 'x' }],
    ['缺 prompt', { name: 'x' }],
    ['name 空白', { name: '   ', prompt: 'x' }],
    ['prompt 空白', { name: 'x', prompt: '  ' }],
    ['intervalMs 非数字', { ...validReq, intervalMs: 'soon' }],
    ['intervalMs 为 0', { ...validReq, intervalMs: 0 }],
    ['intervalMs 为负', { ...validReq, intervalMs: -5 }],
    ['intervalMs 非有限', { ...validReq, intervalMs: Number.POSITIVE_INFINITY }],
  ])('%s → INVALID_REQUEST', (_label, payload) => {
    const { slot, pushes } = makeSlot();
    expect(slot.handleRequest('sched-ghost', payload)).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(pushes).toHaveLength(0);
  });

  it('控制字符被净化;净化后为空 → INVALID_REQUEST', () => {
    const { slot, pushes } = makeSlot();
    expect(
      // 字面控制字符会让整个源文件被 git 判成二进制,这里用转义写法:
      // 源码保持纯 ASCII,运行时才是真的 NUL / BEL。
      slot.handleRequest('sched-ghost', { name: '\u0000\u0007', prompt: 'x' }),
    ).toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });
    expect(pushes).toHaveLength(0);
  });

  it('超长 name / prompt 被截断而不是拒绝', () => {
    const { slot, pushes } = makeSlot();
    const res = slot.handleRequest('sched-ghost', {
      name: 'ん'.repeat(GHOST_SCHEDULE_DRAFT_NAME_MAX_CHARS + 50),
      prompt: 'p'.repeat(GHOST_SCHEDULE_DRAFT_PROMPT_MAX_CHARS + 500),
    });
    expect(res).toEqual({ ok: true });
    expect(pushes[0].name).toHaveLength(GHOST_SCHEDULE_DRAFT_NAME_MAX_CHARS);
    expect(pushes[0].prompt).toHaveLength(GHOST_SCHEDULE_DRAFT_PROMPT_MAX_CHARS);
  });
});

describe('GhostScheduleSlot 频率钳制', () => {
  it('低于 30 分钟的建议被上调,不是被拒', () => {
    const { slot, pushes } = makeSlot();
    expect(slot.handleRequest('sched-ghost', { ...validReq, intervalMs: 60_000 })).toEqual({
      ok: true,
    });
    expect(pushes[0].intervalMs).toBe(GHOST_SCHEDULE_DRAFT_MIN_INTERVAL_SUGGESTION_MS);
  });

  it('高于下限的建议原样透传', () => {
    const { slot, pushes } = makeSlot();
    const twoHours = 2 * 3_600_000;
    slot.handleRequest('sched-ghost', { ...validReq, intervalMs: twoHours });
    expect(pushes[0].intervalMs).toBe(twoHours);
  });

  it('不给建议 → 推送里不带 intervalMs(面板用自己的默认频率)', () => {
    const { slot, pushes } = makeSlot();
    slot.handleRequest('sched-ghost', validReq);
    expect(pushes[0].intervalMs).toBeUndefined();
  });
});

describe('GhostScheduleSlot 骚扰钳制', () => {
  it('间隔内的第二次请求 → RATE_LIMITED', () => {
    const { slot, pushes } = makeSlot({ now: () => 1_000 });
    expect(slot.handleRequest('sched-ghost', validReq)).toEqual({ ok: true });
    expect(slot.handleRequest('sched-ghost', validReq)).toMatchObject({
      ok: false,
      errorCode: 'RATE_LIMITED',
    });
    expect(pushes).toHaveLength(1);
  });

  it('限速按尝试记账:被拒的那次也顺延窗口', () => {
    let now = 0;
    const { slot, pushes } = makeSlot({ now: () => now });
    expect(slot.handleRequest('sched-ghost', validReq)).toEqual({ ok: true });
    now = 10_000; // 仍在 15s 窗口内 → 拒,并把窗口顺延到此刻
    expect(slot.handleRequest('sched-ghost', validReq)).toMatchObject({ ok: false });
    now = 20_000; // 距首次 20s(>15s),但距上次尝试只有 10s → 仍拒
    expect(slot.handleRequest('sched-ghost', validReq)).toMatchObject({
      ok: false,
      errorCode: 'RATE_LIMITED',
    });
    expect(pushes).toHaveLength(1);
  });
});

describe('GhostScheduleSlot 推送内容', () => {
  it('身份由主机按已装清单填,沙箱伪装不了', () => {
    const { slot, pushes } = makeSlot();
    slot.handleRequest('sched-ghost', {
      ...validReq,
      // 沙箱试图自报身份 —— 这些字段一律不该进推送
      ghostId: 'someone-else',
      ghostName: '系统设置',
      iconDataUrl: 'data:image/png;base64,EVIL',
    });
    expect(pushes[0]).toMatchObject({
      ghostId: 'sched-ghost',
      ghostName: '签字门看板',
      iconDataUrl: 'data:image/png;base64,AAAA',
    });
  });

  it('每次请求带独立 requestId(renderer 据此去重,不叠开多个面板)', () => {
    // now 每次调用推进一小时,两次请求都不撞限速。
    const { slot, pushes } = makeSlot();
    slot.handleRequest('sched-ghost', validReq);
    slot.handleRequest('sched-ghost', validReq);
    expect(pushes.map((p) => p.requestId)).toEqual(['req-1', 'req-2']);
  });

  it('没有宿主窗口 → HOST_NOT_READY', () => {
    const { slot } = makeSlot({ broadcast: () => false });
    expect(slot.handleRequest('sched-ghost', validReq)).toMatchObject({
      ok: false,
      errorCode: 'HOST_NOT_READY',
    });
  });

  it('日志不留 prompt 正文(只记长度)', () => {
    const info = vi.fn();
    const { slot } = makeSlot({ log: { info, warn: vi.fn() } });
    slot.handleRequest('sched-ghost', { ...validReq, prompt: '这里是用户面前的业务内容' });
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain('这里是用户面前的业务内容');
    expect(logged).toContain('promptChars');
  });
});

describe('GhostScheduleSlot 硬约束:只能开面板,不能建任务', () => {
  /**
   * 这条不是"检查我们有没有调错 API",而是**结构性**保证:deps 的形状里就没有任何
   * 能写调度存储的东西。将来有人为了"省一步"给它注入 schedule storage,这个用例会
   * 立刻失败 —— 那一步会把「任务必须由用户亲手保存」这唯一的授权动作绕掉。
   */
  it('deps 里不存在任何创建/写调度的能力', () => {
    const { deps } = makeSlot();
    const keys = Object.keys(deps);
    expect(keys.sort()).toEqual(['broadcast', 'getGhost', 'newRequestId', 'now'].sort());
    for (const key of keys) {
      expect(key).not.toMatch(/creat|schedul|storage|insert|save|persist|write/i);
    }
  });

  it('放行时唯一的副作用就是一次广播', () => {
    const broadcast = vi.fn(() => true);
    const { slot } = makeSlot({ broadcast });
    expect(slot.handleRequest('sched-ghost', validReq)).toEqual({ ok: true });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('返回值不携带任何"任务已创建"的信息(拿不到 scheduleId)', () => {
    const { slot } = makeSlot();
    const res = slot.handleRequest('sched-ghost', validReq);
    expect(res).toEqual({ ok: true });
    expect(JSON.stringify(res)).not.toMatch(/scheduleId|created|saved/i);
  });
});
