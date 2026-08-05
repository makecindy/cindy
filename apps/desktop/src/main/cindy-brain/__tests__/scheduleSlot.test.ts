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
import { GhostScheduleSlot, isMainShellWindowUrl, type ScheduleSlotDeps } from '../scheduleSlot';

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
    sendToWindow: vi.fn((payload: GhostScheduleDraftPush) => {
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
    const { slot } = makeSlot({ sendToWindow: () => false });
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
    expect(keys.sort()).toEqual(['getGhost', 'newRequestId', 'now', 'sendToWindow'].sort());
    for (const key of keys) {
      expect(key).not.toMatch(/creat|schedul|storage|insert|save|persist|write/i);
    }
  });

  it('放行时唯一的副作用就是投给一个窗口(不是广播)', () => {
    const sendToWindow = vi.fn(() => true);
    const { slot } = makeSlot({ sendToWindow });
    expect(slot.handleRequest('sched-ghost', validReq)).toEqual({ ok: true });
    // 恰好一次:打断式入口绝不能投多个窗口(#1715 review 同根因三条意见)。
    expect(sendToWindow).toHaveBeenCalledTimes(1);
  });

  /**
   * #1715 review 同根因三条意见(Greptile P1 / Codex P2 / Copilot)的回归:
   * 打断式入口**只能投一个窗口**。装配处的选窗逻辑在 index.ts,这里钉住槽这一侧的
   * 契约——它只调一次 sendToWindow,把"投给谁"整个交给装配处,自己不做任何扇出。
   * 如果将来有人把 deps 改回 broadcast 语义(在一次调用里投多个窗口),
   * 上面「deps 里不存在任何创建/写调度的能力」的键集合断言会先失败。
   */
  it('多窗口场景:一次请求只投递一次,不对窗口做扇出', () => {
    // 假装装配处后面挂着 3 个窗口:槽不该知道、也不该关心有几个。
    const delivered: GhostScheduleDraftPush[] = [];
    const { slot } = makeSlot({
      sendToWindow: (payload) => {
        delivered.push(payload);
        return true;
      },
    });
    expect(slot.handleRequest('sched-ghost', validReq)).toEqual({ ok: true });
    expect(delivered).toHaveLength(1);
  });

  it('没有可投窗口(全部销毁)→ HOST_NOT_READY,不静默丢弃', () => {
    const { slot } = makeSlot({ sendToWindow: () => false });
    expect(slot.handleRequest('sched-ghost', validReq)).toMatchObject({
      ok: false,
      errorCode: 'HOST_NOT_READY',
    });
  });

  /**
   * 钉住**本版**的返回形状:没有任何"任务已创建"的信息。
   * ⚠️ 这不是永久契约 —— 后续版本会引入「任务 ↔ 发起插件」的绑定,插件届时可以查询/
   * 管理**自己绑定的那条**任务(绑定关系即授权边界)。那时本用例需要随新契约调整,
   * 而不是把它当成"插件永远不能知道"的依据。
   */
  it('返回值不携带任何"任务已创建"的信息(拿不到 scheduleId)', () => {
    const { slot } = makeSlot();
    const res = slot.handleRequest('sched-ghost', validReq);
    expect(res).toEqual({ ok: true });
    expect(JSON.stringify(res)).not.toMatch(/scheduleId|created|saved/i);
  });
});

/**
 * 「插件面板聚焦 + 主窗口 + 会话副窗」的顺序不稳定场景(review 第二轮点名要覆盖)。
 *
 * 装配处的选窗规则是:candidates = 全部窗口按判据过滤 → focused 在 candidates 内则用它,
 * 否则取 candidates[0]。这里用判据函数复现那条规则,验证**无论窗口列表顺序如何**,
 * 回落都只会落到真正的主窗口 —— 副窗被判据挡在 candidates 之外,所以它排第几都不影响。
 */
describe('选窗回落:插件面板聚焦时只能落到主窗口', () => {
  const MAIN = 'file:///app/index.html#/cc-agent';
  const SECONDARY = 'file:///app/index.html?secondaryWindow=1&bootSession=s1#/cc-agent';
  const PANEL = 'file:///app/index.html?ghostPanelWindow=codex-reset-planner#/ghost-panel-window';

  /** 复刻 index.ts 装配处的选窗规则(那里拿的是 BrowserWindow,这里用 URL 代表窗口)。 */
  const pick = (all: string[], focused: string | null): string | undefined => {
    const candidates = all.filter((url) => isMainShellWindowUrl(url));
    return focused && candidates.includes(focused) ? focused : candidates[0];
  };

  it.each([
    ['主窗在前', [MAIN, SECONDARY, PANEL]],
    ['副窗在前', [SECONDARY, MAIN, PANEL]],
    ['面板窗在前', [PANEL, SECONDARY, MAIN]],
    ['副窗夹在中间', [PANEL, SECONDARY, MAIN, SECONDARY]],
  ])('%s:focused=插件面板窗 → 回落到主窗口而不是副窗', (_label, all) => {
    expect(pick(all, PANEL)).toBe(MAIN);
  });

  it('focused 本身是主窗口 → 就用它', () => {
    expect(pick([SECONDARY, MAIN, PANEL], MAIN)).toBe(MAIN);
  });

  it('只有副窗与面板窗(没有主窗)→ 无可投窗口,交由装配处回 HOST_NOT_READY', () => {
    expect(pick([SECONDARY, PANEL], PANEL)).toBeUndefined();
  });

  it('多个主窗:focused 不在候选内时取第一个主窗,不随副窗位置漂移', () => {
    const MAIN2 = 'file:///app/index.html#/settings';
    expect(pick([SECONDARY, MAIN, MAIN2], PANEL)).toBe(MAIN);
    expect(pick([SECONDARY, MAIN, MAIN2], MAIN2)).toBe(MAIN2);
  });
});

describe('isMainShellWindowUrl（投给哪个窗口的判据）', () => {
  it.each([
    ['主窗口', 'file:///app/index.html#/cc-agent'],
    ['主窗口带其它 query', 'file:///app/index.html?foo=1#/cc-agent/scheduled'],
    ['dev server', 'http://localhost:5173/#/cc-agent'],
    // 判据取 ==='1',不是 has():带 secondaryWindow=0 的主窗不该被误排除。
    ['主窗口 secondaryWindow=0', 'file:///app/index.html?secondaryWindow=0#/cc-agent'],
  ])('%s → 是主壳窗', (_label, url) => {
    expect(isMainShellWindowUrl(url)).toBe(true);
  });

  it.each([
    // 这两类窗口与 MainLayout 平级,没有草稿订阅、也去不了自动化页。
    ['插件面板独立窗(query)', 'file:///app/index.html?ghostPanelWindow=sign#/ghost-panel-window'],
    ['插件面板独立窗(仅 hash)', 'file:///app/index.html#/ghost-panel-window'],
    ['右侧栏独立窗(query)', 'file:///app/index.html?sidebarWindow=1#/sidebar-window'],
    ['右侧栏独立窗(仅 hash)', 'file:///app/index.html#/sidebar-window'],
    // utility 窗:统一带 ?view=<名字>,一律接不住草稿(review 第三轮)。
    ['语音浮窗', 'file:///app/index.html?view=voice-input-overlay'],
    ['词典 toast', 'file:///app/index.html?view=voice-input-dictionary-toast'],
    ['权限引导窗', 'file:///app/index.html?view=computer-permission-guide'],
    ['权限引导 backdrop', 'file:///app/index.html?view=computer-permission-backdrop'],
    // 按 key 排除而非枚举取值:将来任何新 utility 窗只要沿用 ?view= 约定就自动落在排除侧。
    ['将来某个未知的 utility 窗', 'file:///app/index.html?view=some-future-window'],
    // 插件沙箱窗用自定义 scheme 加载插件内容,被协议判据挡掉 —— 主机 UI 事件不该推给插件。
    ['插件沙箱窗(自定义协议)', 'cindy-ghost://codex-reset-planner/__boot__'],
    // 会话副窗:挂完整壳、技术上接得住,但不是用户建任务时看的窗口(review 第二轮)。
    ['会话副窗(secondaryWindow=1)', 'file:///app/index.html?secondaryWindow=1#/cc-agent'],
    ['会话副窗带 bootSession', 'file:///app/index.html?secondaryWindow=1&bootSession=abc#/cc-agent/x'],
    ['about:blank', 'about:blank'],
    ['空串', ''],
    ['非法 URL', 'not a url'],
  ])('%s → 不是主壳窗', (_label, url) => {
    expect(isMainShellWindowUrl(url)).toBe(false);
  });

  /**
   * 这条是本能力的主使用路径:编写手册 §4.11.2 第 1 步就是「用户在你的插件面板上
   * 点一下」,而面板可以被拉成独立窗口。那一刻 focused 是面板窗——若判据把它当成
   * 可投窗口,草稿就投给了一个接不住它的窗口,用户点了什么都不会发生。
   */
  it('插件面板独立窗绝不能被当作可投窗口(本能力的主使用路径)', () => {
    expect(isMainShellWindowUrl('file:///app/index.html?ghostPanelWindow=codex-reset-planner#/ghost-panel-window')).toBe(false);
  });
});
