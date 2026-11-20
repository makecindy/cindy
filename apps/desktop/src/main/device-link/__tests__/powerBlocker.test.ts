/**
 * KeepAwakeController 单测:验证 powerSaveBlocker 的 start/stop 幂等时序,
 * 无需真实 Electron —— 注入一个内存 backend 模拟 electron.powerSaveBlocker。
 */

import { describe, it, expect, vi } from 'vitest';

// electron 在测试环境不可用;power-blocker 顶层 import { powerSaveBlocker } 仅作默认参数引用,
// 我们始终注入替身,故这里 mock 成惰性对象即可(不会被实际调用)。
vi.mock('electron', () => ({ powerSaveBlocker: {} }));

import { KeepAwakeController, type PowerSaveBlockerBackend } from '../power-blocker';

function makeBackend() {
  const started = new Set<number>();
  let nextId = 1;
  const backend: PowerSaveBlockerBackend = {
    start: vi.fn((_type) => {
      const id = nextId++;
      started.add(id);
      return id;
    }),
    stop: vi.fn((id) => {
      started.delete(id);
    }),
    isStarted: vi.fn((id) => started.has(id)),
  };
  return { backend, started };
}

describe('KeepAwakeController', () => {
  // docs/product-rules/privacy-screen.md (2026-11-14): 「用隐私屏代替锁屏」 includes keeping
  // the computer awake; turning it off restores the user's own choice, never overrides it.
  it.each([false, true])('隐私屏开着时不休眠,关掉后恢复用户自己的选择(用户开着=%s)', (user) => {
    const { backend } = makeBackend();
    const c = new KeepAwakeController(backend);
    c.apply(user);
    c.setPrivacyScreen(true);
    expect(c.active).toBe(true);
    c.apply(false);
    expect(c.active).toBe(true);
    c.apply(user);
    c.setPrivacyScreen(false);
    expect(c.active).toBe(user);
    expect(backend.start).toHaveBeenCalledTimes(1);
  });
  it('apply(true) 启动一个 prevent-app-suspension blocker,重复 apply(true) 幂等', () => {
    const { backend } = makeBackend();
    const c = new KeepAwakeController(backend);

    expect(c.active).toBe(false);
    c.apply(true);
    expect(c.active).toBe(true);
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(backend.start).toHaveBeenCalledWith('prevent-app-suspension');

    c.apply(true); // 幂等:已生效,不再 start
    expect(backend.start).toHaveBeenCalledTimes(1);
  });

  it('apply(false) 停止 blocker;重复 apply(false) 幂等', () => {
    const { backend } = makeBackend();
    const c = new KeepAwakeController(backend);

    c.apply(true);
    c.apply(false);
    expect(c.active).toBe(false);
    expect(backend.stop).toHaveBeenCalledTimes(1);

    c.apply(false); // 未持有,幂等 no-op
    expect(backend.stop).toHaveBeenCalledTimes(1);
  });

  it('off→on→off→on 循环每次都重新 start,不泄漏旧 blocker', () => {
    const { backend } = makeBackend();
    const c = new KeepAwakeController(backend);

    c.apply(true);
    c.apply(false);
    c.apply(true);
    expect(backend.start).toHaveBeenCalledTimes(2);
    expect(backend.stop).toHaveBeenCalledTimes(1);
    expect(c.active).toBe(true);
  });
});
