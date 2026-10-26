// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  registerStatusBarCard,
  resetStatusBarCardsForTest,
} from '../statusBarCards';

beforeEach(() => {
  resetStatusBarCardsForTest();
});

/**
 * 协调器的语义：`request()` = 「本实例成为唯一展开的卡片」，于是**立即通知所有其它登记实例关闭**
 * （包括从未真正展开过的那些 —— 它们的 close 是幂等的，关一张没开的卡不产生副作用）。
 * 要点是「自己不关自己」与「同种类的另一张也会被关」。
 */
describe('statusBarCards 互斥协调器', () => {
  it('跨种类互斥：展开的那张让另一张立刻收起，自己不关自己', () => {
    const closeQuota = vi.fn();
    const closeWindow = vi.fn();
    registerStatusBarCard('quota', closeQuota);
    const windowCard = registerStatusBarCard('context-window', closeWindow);

    windowCard.request();
    expect(closeQuota).toHaveBeenCalledTimes(1);
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it('同种类的第二个实例也能抢到独占权（分屏同时挂载两份底栏）', () => {
    // 分屏 / Orca 面板会同时挂载多个会话视图：按种类登记会互相顶掉关闭回调，
    // 让两张档位卡一起亮着 —— 这正是本协调器要守住的不变量。
    const closePaneA = vi.fn();
    const closePaneB = vi.fn();
    const paneA = registerStatusBarCard('context-window', closePaneA);
    const paneB = registerStatusBarCard('context-window', closePaneB);

    paneB.request();
    expect(closePaneA).toHaveBeenCalledTimes(1);
    expect(closePaneB).not.toHaveBeenCalled();

    paneA.request();
    expect(closePaneB).toHaveBeenCalledTimes(1);
  });

  it('同一实例重复 request 是幂等的（不会反复关别人）', () => {
    const closeQuota = vi.fn();
    registerStatusBarCard('quota', closeQuota);
    const windowCard = registerStatusBarCard('context-window', vi.fn());

    windowCard.request();
    windowCard.request();
    expect(closeQuota).toHaveBeenCalledTimes(1);
  });

  it('release 只对自己生效：非独占者 release 不会把独占位让给别人', () => {
    const closeQuota = vi.fn();
    const quota = registerStatusBarCard('quota', closeQuota);
    const windowCard = registerStatusBarCard('context-window', vi.fn());

    quota.request();
    windowCard.release(); // window 从来不是独占者 → 这次 release 应当无效
    windowCard.request(); // 仍然能正常抢到独占（并关掉 quota）
    expect(closeQuota).toHaveBeenCalledTimes(1);
  });

  it('release 之后同类实例可以再次抢到独占权', () => {
    const closeQuota = vi.fn();
    registerStatusBarCard('quota', closeQuota);
    const windowCard = registerStatusBarCard('context-window', vi.fn());

    windowCard.request();
    windowCard.release();
    windowCard.request();
    expect(closeQuota).toHaveBeenCalledTimes(2);
  });

  it('卸载（unregister）会清掉自己的登记，并让出独占位', () => {
    const closeQuota = vi.fn();
    const quota = registerStatusBarCard('quota', closeQuota);
    const windowCard = registerStatusBarCard('context-window', vi.fn());

    windowCard.request();
    expect(closeQuota).toHaveBeenCalledTimes(1); // window 抢到独占 → quota 被关
    windowCard.unregister();
    windowCard.request(); // 已注销：句柄不再有任何协调权限
    expect(closeQuota).toHaveBeenCalledTimes(1);

    // 独占位已让出 → quota 成为独占者；此时库里已无其它实例，自然没有新的关闭调用。
    quota.request();
    expect(closeQuota).toHaveBeenCalledTimes(1);
  });

  it('同种类先注册者卸载后，后注册者仍是有效独占者且不再关已注销实例', () => {
    const closePaneA = vi.fn();
    const closePaneB = vi.fn();
    const paneA = registerStatusBarCard('context-window', closePaneA);
    const paneB = registerStatusBarCard('context-window', closePaneB);

    paneA.request(); // 同种类的另一份在登记表里 → 会收到关闭（真实 chip 里这是幂等的）
    expect(closePaneB).toHaveBeenCalledTimes(1);
    paneA.unregister();
    closePaneB.mockClear();

    paneB.request();
    expect(closePaneA).not.toHaveBeenCalled();
    expect(closePaneB).not.toHaveBeenCalled();
  });
});
