import { describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../../shared/ghost.js';
import { GhostRuntime, type SandboxHandle, type SandboxHostAdapter } from '../GhostRuntime.js';

/** 假沙箱:load 立即成功;可手动触发 gone(模拟进程崩溃)。 */
class FakeHandle implements SandboxHandle {
  destroyed = false;
  private goneCb: ((d: { reason: string }) => void) | null = null;
  async load(): Promise<void> {}
  destroy(): void {
    this.destroyed = true;
  }
  crashForTest(): void {
    this.goneCb?.({ reason: 'crashed' });
  }
  onGone(cb: (d: { reason: string }) => void): void {
    this.goneCb = cb;
  }
  /** 测试用:外部直接模拟进程死亡。 */
  simulateGone(): void {
    this.goneCb?.({ reason: 'oom' });
  }
}

function chipGhost(id = 'demo'): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 2,
      id,
      name: 'Demo',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: ['cindy'],
    },
    dir: `/fake/brain/${id}`,
    enabled: true,
  };
}

function setup(opts?: { now?: () => number; loadFails?: boolean }) {
  const handles: FakeHandle[] = [];
  const adapter: SandboxHostAdapter = {
    create: () => {
      const h = new FakeHandle();
      if (opts?.loadFails) h.load = async () => Promise.reject(new Error('boom'));
      handles.push(h);
      return h;
    },
  };
  const onFused = vi.fn();
  const runtime = new GhostRuntime({ adapter, onFused, now: opts?.now });
  return { runtime, handles, onFused };
}

describe('GhostRuntime · 状态机', () => {
  it('spawn → running;stop → off,沙箱被销毁', async () => {
    const { runtime, handles } = setup();
    const ghost = chipGhost();
    expect((await runtime.spawn(ghost)).ok).toBe(true);
    expect(runtime.stateOf('demo')).toBe('running');
    runtime.stop('demo');
    expect(runtime.stateOf('demo')).toBe('off');
    expect(handles[0].destroyed).toBe(true);
  });

  it('spawn 幂等:running 中再 spawn 不新建沙箱', async () => {
    const { runtime, handles } = setup();
    await runtime.spawn(chipGhost());
    await runtime.spawn(chipGhost());
    expect(handles.length).toBe(1);
  });

  it('adapter.create 同步 throw(如 app 未 ready)→ 结构化失败 + crashed 记账,state 不卡 starting', async () => {
    let createFails = true;
    const handles: FakeHandle[] = [];
    const adapter: SandboxHostAdapter = {
      create: () => {
        if (createFails) throw new Error('Session can only be received when app is ready');
        const h = new FakeHandle();
        handles.push(h);
        return h;
      },
    };
    const runtime = new GhostRuntime({ adapter, onFused: vi.fn() });
    const r = await runtime.spawn(chipGhost());
    expect(r.ok).toBe(false);
    // 关键:不许卡死在 starting(那会让后续 spawn/stop/resetFuse 全部失效)。
    expect(runtime.stateOf('demo')).toBe('crashed');
    // 环境恢复(app ready)后可直接复活。
    createFails = false;
    expect((await runtime.spawn(chipGhost())).ok).toBe(true);
    expect(runtime.stateOf('demo')).toBe('running');
    expect(handles.length).toBe(1);
  });

  it('单次崩溃 → crashed,可再 spawn 复活', async () => {
    const { runtime, handles, onFused } = setup();
    await runtime.spawn(chipGhost());
    handles[0].simulateGone();
    expect(runtime.stateOf('demo')).toBe('crashed');
    expect(handles[0].destroyed).toBe(true);
    expect(onFused).not.toHaveBeenCalled();
    expect((await runtime.spawn(chipGhost())).ok).toBe(true);
    expect(runtime.stateOf('demo')).toBe('running');
  });

  it('60s 内崩 3 次 → fused + onFused;fused 后 spawn 拒绝;resetFuse 后可复活', async () => {
    let t = 0;
    const { runtime, handles, onFused } = setup({ now: () => t });
    for (let i = 0; i < 3; i++) {
      await runtime.spawn(chipGhost());
      t += 1_000;
      handles[i].simulateGone();
    }
    expect(runtime.stateOf('demo')).toBe('fused');
    expect(onFused).toHaveBeenCalledTimes(1);
    expect((await runtime.spawn(chipGhost())).ok).toBe(false);

    runtime.resetFuse('demo');
    expect(runtime.stateOf('demo')).toBe('off');
    expect((await runtime.spawn(chipGhost())).ok).toBe(true);
  });

  it('崩溃间隔超出 60s 窗口不熔断(滚动淘汰)', async () => {
    let t = 0;
    const { runtime, handles, onFused } = setup({ now: () => t });
    for (let i = 0; i < 3; i++) {
      await runtime.spawn(chipGhost());
      t += 40_000; // 每次崩溃相隔 40s:窗口内永远只有 2 条记录
      handles[i].simulateGone();
    }
    expect(runtime.stateOf('demo')).toBe('crashed');
    expect(onFused).not.toHaveBeenCalled();
  });

  it('入口加载失败按一次崩溃记账(坏 entry 反复 spawn 同样熔断)', async () => {
    let t = 0;
    const { runtime, onFused } = setup({ now: () => t, loadFails: true });
    for (let i = 0; i < 3; i++) {
      const result = await runtime.spawn(chipGhost());
      expect(result.ok).toBe(false);
      t += 1_000;
    }
    expect(runtime.stateOf('demo')).toBe('fused');
    expect(onFused).toHaveBeenCalledTimes(1);
  });

  it('stop 之后迟到的 gone 事件被忽略(不误记崩溃)', async () => {
    const { runtime, handles, onFused } = setup();
    await runtime.spawn(chipGhost());
    runtime.stop('demo');
    handles[0].simulateGone();
    expect(runtime.stateOf('demo')).toBe('off');
    expect(onFused).not.toHaveBeenCalled();
  });

  it('destroyAll 销毁全部沙箱并归 off', async () => {
    const { runtime, handles } = setup();
    await runtime.spawn(chipGhost('a'));
    await runtime.spawn(chipGhost('b'));
    runtime.destroyAll();
    expect(handles.every((h) => h.destroyed)).toBe(true);
    expect(runtime.stateOf('a')).toBe('off');
    expect(runtime.stateOf('b')).toBe('off');
  });
});
