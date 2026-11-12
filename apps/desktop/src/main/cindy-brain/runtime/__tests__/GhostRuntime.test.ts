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
    },
    dir: `/fake/brain/${id}`,
    enabled: true,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
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
  it('does not start an instance the host holds stopped until restart', async () => {
    const handles: FakeHandle[] = [];
    let blocked: string | null = 'restart Cindy';
    const runtime = new GhostRuntime({
      adapter: { create: () => { const handle = new FakeHandle(); handles.push(handle); return handle; } },
      startBlockedReason: (id) => (id === 'demo' ? blocked : null),
    });
    await expect(runtime.spawn(chipGhost())).resolves.toEqual({ ok: false, reason: 'restart Cindy' });
    expect(handles).toHaveLength(0);
    expect(runtime.stateOf('demo')).toBe('off');
    blocked = null;
    await expect(runtime.spawn(chipGhost())).resolves.toMatchObject({ ok: true });
  });

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

  it('换版后再 spawn:旧安装拉起的沙箱销毁并按新回执重开(面板分区才同源)', async () => {
    const { runtime, handles } = setup();
    await runtime.spawn(chipGhost());
    const updated = chipGhost();
    updated.manifest = { ...updated.manifest, version: '1.0.1' };
    updated.approval = { state: 'approved', revision: '00000000-0000-4000-8000-000000000002' };
    const result = await runtime.spawn(updated);
    expect(result).toEqual({ ok: true, state: 'running' });
    expect(handles.length).toBe(2);
    expect(handles[0].destroyed).toBe(true);
    expect(handles[1].destroyed).toBe(false);
    // 同一份新记录再 spawn 仍幂等。
    await runtime.spawn(updated);
    expect(handles.length).toBe(2);
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

  it('同 ghostId 的 root 与企业实例可同时 running', async () => {
    const { runtime, handles } = setup();
    const root = chipGhost('helper');
    const enterprise: InstalledGhost = {
      ...chipGhost('helper'),
      namespace: 'acme',
      dir: '/fake/brain/_ns/acme/helper',
    };
    expect((await runtime.spawn(root)).ok).toBe(true);
    expect((await runtime.spawn(enterprise)).ok).toBe(true);
    expect(handles.length).toBe(2);
    expect(runtime.stateOf('helper')).toBe('running');
    expect(runtime.stateOf('_ns__acme__helper')).toBe('running');
    runtime.stop('helper');
    expect(runtime.stateOf('helper')).toBe('off');
    expect(runtime.stateOf('_ns__acme__helper')).toBe('running');
  });
});

// PR #6569: a resident plugin can still be loading when sync calls spawn again.
// Existing tests used immediately-loaded sandboxes; these deferred loads exercise
// the production readiness boundary and stale-handle rejection without real waits (unit).
it.each(['ready', 'failed', 'replaced'] as const)('waits for the same sandbox load before delivery: %s', async (outcome) => {
  const loads: Array<{ resolve(): void; reject(error: Error): void }> = [];
  const runtime = new GhostRuntime({ adapter: { create: () => {
    const handle = new FakeHandle();
    handle.load = () => new Promise<void>((resolve, reject) => { loads.push({ resolve, reject }); });
    return handle;
  } } });
  const first = runtime.spawn(chipGhost());
  expect(await runtime.spawn(chipGhost())).toEqual({ ok: true, state: 'starting' });
  let delivered = false;
  const readiness = runtime.waitUntilRunning('demo').then(ready => { delivered = ready; return ready; });
  await Promise.resolve();
  expect(delivered).toBe(false);
  if (outcome === 'replaced') {
    runtime.stop('demo');
    const replacement = runtime.spawn(chipGhost());
    loads[0].resolve(); await first;
    expect(await readiness).toBe(false);
    expect(runtime.stateOf('demo')).toBe('starting');
    loads[1].resolve(); await replacement;
    expect(await runtime.waitUntilRunning('demo')).toBe(true);
  } else {
    if (outcome === 'failed') loads[0].reject(new Error('load failed'));
    else loads[0].resolve();
    await first;
    expect(await readiness).toBe(outcome === 'ready');
  }
  runtime.destroyAll();
});
