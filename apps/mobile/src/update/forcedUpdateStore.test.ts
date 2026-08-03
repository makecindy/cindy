import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __testing,
  clearForcedUpdate,
  enterForcedUpdate,
  getForcedUpdateRevision,
  getForcedUpdateTarget,
  subscribeForcedUpdate,
  type ForcedUpdateTarget,
} from './forcedUpdateStore';

function target(overrides: Partial<ForcedUpdateTarget> = {}): ForcedUpdateTarget {
  return {
    version: '2.0.0',
    runtimeVersion: 'rtv-new',
    installUrl: 'https://cdn.example/install',
    itmsUrl: 'itms-services://?action=download-manifest&url=https://cdn.example/m.plist',
    ...overrides,
  };
}

afterEach(() => {
  __testing.reset();
});

describe('forcedUpdateStore', () => {
  it('初始无阻断目标', () => {
    expect(getForcedUpdateTarget()).toBeNull();
  });

  it('进入阻断态后可读取目标并通知订阅者', () => {
    const listener = vi.fn();
    subscribeForcedUpdate(listener);
    enterForcedUpdate(target());
    expect(getForcedUpdateTarget()).toEqual(target());
    expect(listener).toHaveBeenCalledOnce();
  });

  it('同一目标重复进入 → 幂等,不重复通知(resume 每 5 分钟命中一次也不会重渲染)', () => {
    const listener = vi.fn();
    subscribeForcedUpdate(listener);
    enterForcedUpdate(target());
    enterForcedUpdate(target());
    enterForcedUpdate({ ...target() });
    expect(listener).toHaveBeenCalledOnce();
  });

  it('目标变化(更高版本)→ 更新并通知', () => {
    const listener = vi.fn();
    subscribeForcedUpdate(listener);
    enterForcedUpdate(target());
    enterForcedUpdate(target({ version: '2.1.0' }));
    expect(getForcedUpdateTarget()?.version).toBe('2.1.0');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('取消订阅后不再收到通知', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeForcedUpdate(listener);
    unsubscribe();
    enterForcedUpdate(target());
    expect(listener).not.toHaveBeenCalled();
    expect(getForcedUpdateTarget()).not.toBeNull();
  });

  it('解除阻断态 → 目标清空并通知(服务端撤回门槛后的恢复入口)', () => {
    enterForcedUpdate(target());
    const listener = vi.fn();
    subscribeForcedUpdate(listener);
    clearForcedUpdate();
    expect(getForcedUpdateTarget()).toBeNull();
    expect(listener).toHaveBeenCalledOnce();
  });

  it('本来就没阻断时解除 → 幂等,不通知', () => {
    const listener = vi.fn();
    subscribeForcedUpdate(listener);
    clearForcedUpdate();
    expect(listener).not.toHaveBeenCalled();
  });

  it('解除后可再次进入(下一轮门槛)', () => {
    enterForcedUpdate(target());
    clearForcedUpdate();
    enterForcedUpdate(target());
    expect(getForcedUpdateTarget()).toEqual(target());
  });

  it('compare-and-clear:revision 已前进 → 旧结论作废,不解除', () => {
    // 竞态:核对发起时读到 revision=1,在途期间另一条路径写入更新的强更目标(revision=2),
    // 旧结论带着 1 回来时不得把用户放进业务树。
    enterForcedUpdate(target());
    const stale = getForcedUpdateRevision();
    enterForcedUpdate(target({ version: '2.1.0' })); // 更新的观察落地
    clearForcedUpdate(stale);
    expect(getForcedUpdateTarget()?.version).toBe('2.1.0');
  });

  it('等值目标的无守卫写入也推进 revision → 在途旧结论作废', () => {
    // 另一条检查路径的迟到响应写入**相同**目标时,状态没变但确实是一次新观察落地;
    // 若不推进 revision,在途核对基于旧 revision 的"解除"结论仍会通过 compare。
    enterForcedUpdate(target());
    const stale = getForcedUpdateRevision();
    enterForcedUpdate(target()); // 等值、无 expectedRevision
    expect(getForcedUpdateRevision()).not.toBe(stale);
    clearForcedUpdate(stale);
    expect(getForcedUpdateTarget()).not.toBeNull();
  });

  it('等值目标的带守卫写入不推进 revision(自己的刷新不该作废自己)', () => {
    enterForcedUpdate(target());
    const rev = getForcedUpdateRevision();
    enterForcedUpdate(target(), rev); // 核对回来发现目标没变
    expect(getForcedUpdateRevision()).toBe(rev);
  });

  it('compare-and-clear:revision 未变 → 正常解除', () => {
    enterForcedUpdate(target());
    clearForcedUpdate(getForcedUpdateRevision());
    expect(getForcedUpdateTarget()).toBeNull();
  });

  it('compare-and-set:revision 已前进 → 旧 target 不回写(按钮不退回旧链接)', () => {
    enterForcedUpdate(target());
    const stale = getForcedUpdateRevision();
    enterForcedUpdate(target({ installUrl: 'https://cdn.example/fixed' }));
    enterForcedUpdate(target({ installUrl: 'https://cdn.example/old' }), stale);
    expect(getForcedUpdateTarget()?.installUrl).toBe('https://cdn.example/fixed');
  });

  it('不传 revision 的调用不受 compare 影响(首次进入 / 旧调用点)', () => {
    enterForcedUpdate(target());
    enterForcedUpdate(target({ version: '3.0.0' }));
    expect(getForcedUpdateTarget()?.version).toBe('3.0.0');
    clearForcedUpdate();
    expect(getForcedUpdateTarget()).toBeNull();
  });

  it('单个订阅者抛错不影响其它订阅者', () => {
    const bad = vi.fn(() => { throw new Error('boom'); });
    const good = vi.fn();
    subscribeForcedUpdate(bad);
    subscribeForcedUpdate(good);
    expect(() => enterForcedUpdate(target())).not.toThrow();
    expect(good).toHaveBeenCalledOnce();
  });
});
