/**
 * presenceOfflineGate.test.ts — 发送门禁判据的优先级链与代次生命周期。
 * ---------------------------------------------------------------------------
 * 判据按证据新鲜度排优先级(入站可达 > 当代 presence > 跨代结论 > fail-open),
 * 三层都由一次真实缺陷推出来,故重点覆盖:
 *  - relay 重连时序(ws-online 全量重放跑在本代首帧 presence 之前);
 *  - presence 滞后 / 误报持续时,入站帧证据必须能覆盖当代 false;
 *  - 两类证据乱序到达的交错序列(哪一帧最新就以它为准)。
 */
import { describe, it, expect } from 'vitest';
import { createPresenceOfflineGate } from '../presenceOfflineGate';

/** 模拟 index.ts 的接线:当代 presence 视图是单一真相,gate 叠加证据层。 */
function makeWiring() {
  const view = new Map<string, boolean>();
  const gate = createPresenceOfflineGate((id) => view.get(id));
  /** 复刻 onStatusChange 非 online 分支:先转存,再清空当代视图。 */
  const endGeneration = (): void => {
    gate.carryOverGenerationEnd(view);
    view.clear();
  };
  /** 复刻 onPresenceChanged:写当代视图 + 让位早于本帧的证据。 */
  const presence = (id: string, online: boolean): void => {
    view.set(id, online);
    gate.observePresenceFrame(id);
  };
  /** 复刻 onFrame:收到来自该设备的入站帧。 */
  const inboundFrame = (id: string): void => gate.observeReachable(id);
  return { view, gate, endGeneration, presence, inboundFrame };
}

describe('presenceOfflineGate 优先级链', () => {
  it('当代 presence:online 放行、offline 拦、从未观察过 fail-open', () => {
    const { gate, presence } = makeWiring();
    expect(gate.isExplicitlyOffline('never-seen')).toBe(false);
    presence('dev-on', true);
    presence('dev-off', false);
    expect(gate.isExplicitlyOffline('dev-on')).toBe(false);
    expect(gate.isExplicitlyOffline('dev-off')).toBe(true);
  });

  it('入站可达证据覆盖当代 offline:presence 滞后/误报时不长期挡住已回归的 peer', () => {
    // review 第三轮:定向 flush 首轮失败后的无参重试与订阅重放都查同一判据,
    // 若当代 false 压过刚到的入站帧,已 link-open 的 peer 会被拦到 TTL 丢结果。
    const { gate, presence, inboundFrame } = makeWiring();
    presence('dev-back', false);
    expect(gate.isExplicitlyOffline('dev-back')).toBe(true);

    inboundFrame('dev-back'); // link-open / invoke / push 任一
    expect(gate.isExplicitlyOffline('dev-back')).toBe(false);
  });

  it('新 presence 帧让可达证据让位:证据不做永久豁免,以最新一帧为准', () => {
    const { gate, presence, inboundFrame } = makeWiring();
    inboundFrame('dev-x');
    expect(gate.isExplicitlyOffline('dev-x')).toBe(false);

    // 设备随后真的下线,relay 推来新的 offline:重新拦住
    presence('dev-x', false);
    expect(gate.isExplicitlyOffline('dev-x')).toBe(true);
    expect(gate.reachableCount()).toBe(0);

    // 再回来:入站帧又成为最新证据
    inboundFrame('dev-x');
    expect(gate.isExplicitlyOffline('dev-x')).toBe(false);
  });

  it('交错到达:同一 peer 的 presence 与入站帧任意顺序,始终以最后一条为准', () => {
    const { gate, presence, inboundFrame } = makeWiring();
    const timeline: Array<[() => void, boolean]> = [
      [() => presence('dev-i', false), true],
      [() => inboundFrame('dev-i'), false],
      [() => inboundFrame('dev-i'), false], // 重复入站帧幂等
      [() => presence('dev-i', false), true],
      [() => presence('dev-i', true), false],
      [() => inboundFrame('dev-i'), false],
      [() => presence('dev-i', false), true],
    ];
    for (const [step, expectedOffline] of timeline) {
      step();
      expect(gate.isExplicitlyOffline('dev-i')).toBe(expectedOffline);
    }
  });
});

describe('presenceOfflineGate 连接代次生命周期', () => {
  it('跨连接代次保留离线结论:重连后视图已清空,已知离线目标仍被拦(要害用例)', () => {
    const { gate, view, endGeneration, presence } = makeWiring();
    presence('dev-off', false);
    presence('dev-on', true);

    // relay 断线:status=connecting → 转存 + 清空当代视图
    endGeneration();
    expect(view.size).toBe(0);
    expect(gate.carriedOverCount()).toBe(1);

    // 此刻正是 ws-online 全量重放的时点(本代首帧 presence 尚未到达)
    expect(gate.isExplicitlyOffline('dev-off')).toBe(true); // 上一代离线结论生效
    expect(gate.isExplicitlyOffline('dev-on')).toBe(false); // 上一代在线者不受影响
    expect(gate.isExplicitlyOffline('never-seen')).toBe(false); // 仍 fail-open
  });

  it('跨代结论在当代任一证据到达后让位(presence 帧或入站帧都可)', () => {
    const viaPresence = makeWiring();
    viaPresence.presence('dev-a', false);
    viaPresence.endGeneration();
    viaPresence.presence('dev-a', true);
    expect(viaPresence.gate.isExplicitlyOffline('dev-a')).toBe(false);
    expect(viaPresence.gate.carriedOverCount()).toBe(0);

    const viaFrame = makeWiring();
    viaFrame.presence('dev-b', false);
    viaFrame.endGeneration();
    viaFrame.inboundFrame('dev-b');
    expect(viaFrame.gate.isExplicitlyOffline('dev-b')).toBe(false);
    expect(viaFrame.gate.carriedOverCount()).toBe(0);
  });

  it('仍离线的设备在新一代 presence 里保持被拦(当代值接管跨代结论)', () => {
    const { gate, endGeneration, presence } = makeWiring();
    presence('dev-off', false);
    endGeneration();
    presence('dev-off', false);
    expect(gate.isExplicitlyOffline('dev-off')).toBe(true);
    expect(gate.carriedOverCount()).toBe(0); // 由当代视图承担,无需跨代兜底
  });

  it('代次结束:可达证据随旧连接失效而清空,且被它覆盖过的设备不转存为离线', () => {
    // 自相矛盾防护:本代最终判断是「可达」的设备,不该在下一代以 offline 身份复活。
    const { gate, endGeneration, presence, inboundFrame } = makeWiring();
    presence('dev-lagging', false); // presence 误报/滞后
    inboundFrame('dev-lagging'); // 但它确实在给我们发帧
    expect(gate.isExplicitlyOffline('dev-lagging')).toBe(false);

    endGeneration();
    expect(gate.reachableCount()).toBe(0); // 证据随旧连接失效
    expect(gate.carriedOverCount()).toBe(0); // 未被转存为跨代离线
    expect(gate.isExplicitlyOffline('dev-lagging')).toBe(false); // 新代 fail-open
  });

  it('多次连续断线不累积错误结论;reset(登出/失去持有权)整体翻篇', () => {
    const { gate, endGeneration, presence } = makeWiring();
    presence('dev-off', false);
    endGeneration();
    endGeneration(); // 第二次断线:当代视图本就是空的,不产生新结论
    expect(gate.carriedOverCount()).toBe(1);
    expect(gate.isExplicitlyOffline('dev-off')).toBe(true);

    gate.reset();
    expect(gate.carriedOverCount()).toBe(0);
    expect(gate.isExplicitlyOffline('dev-off')).toBe(false); // 不串到下一段链路
  });
});
