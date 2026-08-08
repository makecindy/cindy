/**
 * presenceOfflineGate.test.ts — 发送门禁判据的四条不变量。
 * ---------------------------------------------------------------------------
 * 重点是 relay 重连时序:presence 视图在 connecting 时清空,而 ws-online 全量
 * 重放跑在本代首帧 presence 之前——判据必须沿用上一代的离线事实,否则门禁在这条
 * (2026-08-08 盲发主路径)上形同虚设。
 */
import { describe, it, expect } from 'vitest';
import { createPresenceOfflineGate } from '../presenceOfflineGate';

/** 模拟 index.ts 的当代 presence 在线视图(单一真相,gate 只读它)。 */
function makeView() {
  const view = new Map<string, boolean>();
  const gate = createPresenceOfflineGate((id) => view.get(id));
  /** 复刻 onStatusChange 非 online 分支:先转存,再清空。 */
  const endGeneration = (): void => {
    gate.carryOverGenerationEnd(view);
    view.clear();
  };
  /** 复刻 onPresenceChanged:写当代视图 + 让位跨代结论。 */
  const observe = (id: string, online: boolean): void => {
    view.set(id, online);
    gate.observePresence(id);
  };
  return { view, gate, endGeneration, observe };
}

describe('presenceOfflineGate', () => {
  it('当代事实优先:online 放行、offline 拦、从未观察过 fail-open', () => {
    const { gate, observe } = makeView();
    expect(gate.isExplicitlyOffline('never-seen')).toBe(false);
    observe('dev-on', true);
    observe('dev-off', false);
    expect(gate.isExplicitlyOffline('dev-on')).toBe(false);
    expect(gate.isExplicitlyOffline('dev-off')).toBe(true);
  });

  it('跨连接代次保留离线事实:重连后视图已清空,已知离线目标仍被拦(要害用例)', () => {
    const { gate, view, endGeneration, observe } = makeView();
    observe('dev-off', false);
    observe('dev-on', true);

    // relay 断线:status=connecting → 转存 + 清空当代视图
    endGeneration();
    expect(view.size).toBe(0);
    expect(gate.carriedOverCount()).toBe(1);

    // 此刻正是 ws-online 全量重放的时点(本代首帧 presence 尚未到达)
    expect(gate.isExplicitlyOffline('dev-off')).toBe(true); // 上一代离线事实生效
    expect(gate.isExplicitlyOffline('dev-on')).toBe(false); // 上一代在线者不受影响
    expect(gate.isExplicitlyOffline('never-seen')).toBe(false); // 仍 fail-open
  });

  it('单帧让位:本代 presence 到达即由当代事实回答(设备回归立刻放行)', () => {
    const { gate, endGeneration, observe } = makeView();
    observe('dev-off', false);
    endGeneration();
    expect(gate.isExplicitlyOffline('dev-off')).toBe(true);

    // 设备在新一代回归:首帧 online → 跨代结论作废,立即放行
    observe('dev-off', true);
    expect(gate.isExplicitlyOffline('dev-off')).toBe(false);
    expect(gate.carriedOverCount()).toBe(0);
  });

  it('仍离线的设备在新一代 presence 里保持被拦(当代 offline 接管跨代结论)', () => {
    const { gate, endGeneration, observe } = makeView();
    observe('dev-off', false);
    endGeneration();
    observe('dev-off', false);
    expect(gate.isExplicitlyOffline('dev-off')).toBe(true);
    expect(gate.carriedOverCount()).toBe(0); // 由当代视图承担,不再需要跨代兜底
  });

  it('多次连续断线不累积错误结论;reset(登出/失去持有权)整体翻篇', () => {
    const { gate, endGeneration, observe } = makeView();
    observe('dev-off', false);
    endGeneration();
    endGeneration(); // 第二次断线:当代视图本就是空的,不产生新结论
    expect(gate.carriedOverCount()).toBe(1);
    expect(gate.isExplicitlyOffline('dev-off')).toBe(true);

    gate.reset();
    expect(gate.carriedOverCount()).toBe(0);
    expect(gate.isExplicitlyOffline('dev-off')).toBe(false); // 不串到下一段链路
  });
});
