import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  WorkdirProbeHostClient,
  type WorkdirProbeChildLike,
} from '../WorkdirProbeHostClient.js';
import type { WorkdirProbeRequest, WorkdirProbeResponse } from '../protocol.js';

class FakeChild extends EventEmitter implements WorkdirProbeChildLike {
  readonly posted: WorkdirProbeRequest[] = [];
  killResult = true;
  kill = vi.fn(() => this.killResult);

  postMessage(message: unknown): void {
    this.posted.push(message as WorkdirProbeRequest);
  }

  respond(isDirectory = true): void {
    const request = this.posted.at(-1)!;
    const response: WorkdirProbeResponse = {
      kind: 'result',
      id: request.id,
      result: { ok: true, isDirectory },
    };
    this.emit('message', response);
  }
}

function createHarness(options: { maxWorkers?: number; maxQueued?: number } = {}) {
  const children: FakeChild[] = [];
  const client = new WorkdirProbeHostClient({
    fork: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    log: { warn: vi.fn() },
    ...options,
  });
  return { client, children };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('WorkdirProbeHostClient', () => {
  it('single-flights equivalent paths', async () => {
    const { client, children } = createHarness();

    const first = client.probe('/share/a', '/share/a', 1_000);
    const second = client.probe('/share/a/', '/share/a', 1_000);

    expect(children).toHaveLength(1);
    expect(children[0].posted).toHaveLength(1);
    children[0].respond();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, isDirectory: true },
      { ok: true, isDirectory: true },
    ]);
    client.dispose();
  });

  it('kills timed-out hosts, releases slots, and runs a queued healthy probe', async () => {
    vi.useFakeTimers();
    const { client, children } = createHarness({ maxWorkers: 2 });

    const first = client.probe('/share/a', '/share/a', 100);
    const second = client.probe('/share/b', '/share/b', 100);
    const healthy = client.probe('/local/healthy', '/local/healthy', 200);
    const failures = Promise.allSettled([first, second]);

    expect(children).toHaveLength(2);
    expect(children[0].posted[0].dir).toBe('/share/a');
    expect(children[1].posted[0].dir).toBe('/share/b');

    await vi.advanceTimersByTimeAsync(100);

    expect(children[0].kill).toHaveBeenCalledOnce();
    expect(children[1].kill).toHaveBeenCalledOnce();
    expect(children).toHaveLength(2);
    children[0].emit('exit', 0);
    children[1].emit('exit', 0);
    expect(children).toHaveLength(3);
    expect(children[2].posted[0].dir).toBe('/local/healthy');
    children[2].respond();

    await expect(healthy).resolves.toEqual({ ok: true, isDirectory: true });
    await expect(failures).resolves.toEqual([
      expect.objectContaining({ status: 'rejected' }),
      expect.objectContaining({ status: 'rejected' }),
    ]);
    client.dispose();
  });

  it('allows the same path to retry on a fresh host after timeout', async () => {
    vi.useFakeTimers();
    const { client, children } = createHarness({ maxWorkers: 1 });

    const first = client.probe('/share/a', '/share/a', 50);
    const firstFailure = first.catch((error) => error);
    await vi.advanceTimersByTimeAsync(50);
    await expect(firstFailure).resolves.toMatchObject({ code: 'WORKDIR_PROBE_TIMEOUT' });
    children[0].emit('exit', 0);

    const retry = client.probe('/share/a', '/share/a', 50);
    expect(children).toHaveLength(2);
    children[1].respond();
    await expect(retry).resolves.toEqual({ ok: true, isDirectory: true });
    client.dispose();
  });

  it('waits for a busy slot but bounds the queue', async () => {
    vi.useFakeTimers();
    const { client } = createHarness({ maxWorkers: 1, maxQueued: 1 });

    const active = client.probe('/share/a', '/share/a', 100);
    const queued = client.probe('/share/b', '/share/b', 100);
    const overflow = client.probe('/share/c', '/share/c', 100);
    const settled = Promise.allSettled([active, queued]);

    await expect(overflow).rejects.toMatchObject({ code: 'WORKDIR_PROBE_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(100);
    await expect(settled).resolves.toEqual([
      expect.objectContaining({ status: 'rejected' }),
      expect.objectContaining({ status: 'rejected' }),
    ]);
    client.dispose();
  });

  it('does not replace a timed-out host until exit is confirmed, even when kill returns false', async () => {
    vi.useFakeTimers();
    const { client, children } = createHarness({ maxWorkers: 1 });

    const first = client.probe('/share/a', '/share/a', 50);
    children[0].killResult = false;
    const firstFailure = first.catch((error) => error);
    await vi.advanceTimersByTimeAsync(50);
    await expect(firstFailure).resolves.toMatchObject({ code: 'WORKDIR_PROBE_TIMEOUT' });

    const second = client.probe('/local/healthy', '/local/healthy', 100);
    expect(children).toHaveLength(1);
    expect(children[0].kill).toHaveReturnedWith(false);

    children[0].emit('exit', 0);
    expect(children).toHaveLength(2);
    children[1].respond();
    await expect(second).resolves.toEqual({ ok: true, isDirectory: true });
    client.dispose();
  });

  it('shares one end-to-end deadline between queue wait and active probing', async () => {
    vi.useFakeTimers();
    const { client, children } = createHarness({ maxWorkers: 1 });

    const blocker = client.probe('/share/a', '/share/a', 100);
    const blockerFailure = blocker.catch((error) => error);
    const queued = client.probe('/share/b', '/share/b', 150);
    let queuedSettled = false;
    const queuedFailure = queued.catch((error) => {
      queuedSettled = true;
      return error;
    });

    await vi.advanceTimersByTimeAsync(100);
    await expect(blockerFailure).resolves.toMatchObject({ code: 'WORKDIR_PROBE_TIMEOUT' });
    children[0].emit('exit', 0);
    expect(children[1].posted[0].dir).toBe('/share/b');

    await vi.advanceTimersByTimeAsync(49);
    expect(queuedSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(queuedFailure).resolves.toMatchObject({ code: 'WORKDIR_PROBE_TIMEOUT' });
    client.dispose();
  });
});

describe('WorkdirProbeHostClient validate/availability(IM 渠道探测 job)', () => {
  it('runs validate through the pool and returns the resolved real path', async () => {
    const children: FakeChild[] = [];
    const client = new WorkdirProbeHostClient({
      fork: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      log: { warn: vi.fn() },
    });

    const pending = client.validate('/share/pick', '/share/pick', 1_000);
    const request = children[0].posted[0];
    expect(request.kind).toBe('validate');
    children[0].emit('message', {
      kind: 'result',
      id: request.id,
      result: { ok: true, realPath: '/resolved' },
    });
    await expect(pending).resolves.toEqual({ ok: true, realPath: '/resolved' });
    client.dispose();
  });

  it('kills a hung validate (dead-share realpath) and frees the slot for a healthy probe', async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const client = new WorkdirProbeHostClient({
      fork: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      log: { warn: vi.fn() },
      maxWorkers: 1,
    });

    const hung = client.validate('/share/dead', '/share/dead', 100);
    const hungFailure = hung.catch((error) => error);
    const healthy = client.validate('/local/ok', '/local/ok', 200);

    expect(children).toHaveLength(1);
    expect(children[0].posted[0]).toMatchObject({ kind: 'validate', dir: '/share/dead' });

    await vi.advanceTimersByTimeAsync(100);
    expect(children[0].kill).toHaveBeenCalled();
    await expect(hungFailure).resolves.toMatchObject({ code: 'WORKDIR_PROBE_TIMEOUT' });
    children[0].emit('exit', 0);

    // 槽位释放 → 新 worker 承接排队的健康探测(评审场景: 挂死探针不饿死健康目录)。
    const worker = children[children.length - 1];
    expect(worker.posted[0]).toMatchObject({ kind: 'validate', dir: '/local/ok' });
    worker.emit('message', {
      kind: 'result',
      id: worker.posted[0].id,
      result: { ok: true, realPath: '/local/ok' },
    });
    await expect(healthy).resolves.toEqual({ ok: true, realPath: '/local/ok' });
    client.dispose();
  });

  it('maps availability results and boundary failures', async () => {
    const children: FakeChild[] = [];
    const client = new WorkdirProbeHostClient({
      fork: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      log: { warn: vi.fn() },
    });

    const pending = client.availability('/share/a', '/share/a', 1_000);
    const request = children[0].posted[0];
    expect(request.kind).toBe('availability');
    children[0].emit('message', {
      kind: 'result',
      id: request.id,
      result: { ok: true, usable: true },
    });
    await expect(pending).resolves.toEqual({ ok: true, usable: true });
    client.dispose();
  });
});

describe('WorkdirProbeHostClient single-flight 按 job 类型隔离', () => {
  it('同路径并发 probe + availability: 各自获得正确形态的结果, 互不复用', async () => {
    const children: FakeChild[] = [];
    const client = new WorkdirProbeHostClient({
      fork: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      log: { warn: vi.fn() },
    });

    const stat = client.probe('/share/a', '/share/a', 1_000);
    const avail = client.availability('/share/a', '/share/a', 1_000);

    expect(children).toHaveLength(2);
    expect(children[0].posted[0].kind).toBe('probe');
    expect(children[1].posted[0].kind).toBe('availability');
    children[0].emit('message', {
      kind: 'result',
      id: children[0].posted[0].id,
      result: { ok: true, isDirectory: true },
    });
    children[1].emit('message', {
      kind: 'result',
      id: children[1].posted[0].id,
      result: { ok: true, usable: false },
    });
    await expect(stat).resolves.toEqual({ ok: true, isDirectory: true });
    await expect(avail).resolves.toEqual({ ok: true, usable: false });
    client.dispose();
  });

  it('同路径并发 validate + availability: 独立执行, 不跨类型复用', async () => {
    const children: FakeChild[] = [];
    const client = new WorkdirProbeHostClient({
      fork: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      log: { warn: vi.fn() },
    });

    const validate = client.validate('/share/a', '/share/a', 1_000);
    const avail = client.availability('/share/a', '/share/a', 1_000);

    // 设置类容量 = maxWorkers-1: 第二个设置 job 先排队(见容量隔离用例),
    // 不与第一个并行占满两个 worker。
    expect(children).toHaveLength(1);
    expect(children[0].posted[0].kind).toBe('validate');
    children[0].emit('message', {
      kind: 'result',
      id: children[0].posted[0].id,
      result: { ok: true, realPath: '/resolved' },
    });
    await expect(validate).resolves.toEqual({ ok: true, realPath: '/resolved' });

    // 槽位归还后, 排队的 availability 在同一 worker 上启动(仍是两次独立执行)。
    expect(children).toHaveLength(1);
    expect(children[0].posted[1].kind).toBe('availability');
    children[0].emit('message', {
      kind: 'result',
      id: children[0].posted[1].id,
      result: { ok: true, usable: true },
    });
    await expect(avail).resolves.toEqual({ ok: true, usable: true });
    client.dispose();
  });

  it('同类型同路径仍然复用(不放大探测次数)', async () => {
    const children: FakeChild[] = [];
    const client = new WorkdirProbeHostClient({
      fork: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      log: { warn: vi.fn() },
    });

    const first = client.validate('/share/a', '/share/a', 1_000);
    const second = client.validate('/share/a', '/share/a', 1_000);
    expect(children).toHaveLength(1);
    children[0].emit('message', {
      kind: 'result',
      id: children[0].posted[0].id,
      result: { ok: true, realPath: '/resolved' },
    });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, realPath: '/resolved' },
      { ok: true, realPath: '/resolved' },
    ]);
    client.dispose();
  });
});

describe('WorkdirProbeHostClient 容量隔离(设置类探针不得挤占安全 probe 保留槽)', () => {
  function createClient(options: { maxWorkers?: number; maxQueued?: number } = {}) {
    const children: FakeChild[] = [];
    const client = new WorkdirProbeHostClient({
      fork: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      log: { warn: vi.fn() },
      ...options,
    });
    return { client, children };
  }

  function respond(
    child: FakeChild,
    index: number,
    result: { ok: true; isDirectory: boolean } | { ok: true; realPath: string } | { ok: true; usable: boolean },
  ): void {
    child.emit('message', { kind: 'result', id: child.posted[index].id, result });
  }

  it('两个设置类 job 同时提交: 第二个排队, 不与第一个并行占满 worker', async () => {
    const { client, children } = createClient();

    const validate = client.validate('/share/a', '/share/a', 5_000);
    const availability = client.availability('/share/b', '/share/b', 5_000);

    expect(children).toHaveLength(1);
    expect(children[0].posted[0]).toMatchObject({ kind: 'validate', dir: '/share/a' });
    respond(children[0], 0, { ok: true, realPath: '/resolved' });
    await expect(validate).resolves.toEqual({ ok: true, realPath: '/resolved' });

    // 槽位归还后第二个设置 job 才启动(同一 worker 顺序复用)。
    expect(children).toHaveLength(1);
    expect(children[0].posted[1]).toMatchObject({ kind: 'availability', dir: '/share/b' });
    respond(children[0], 1, { ok: true, usable: true });
    await expect(availability).resolves.toEqual({ ok: true, usable: true });
    client.dispose();
  });

  it('设置探针挂死时, 后来的远程安全 probe 立即使用保留槽并成功', async () => {
    // P2: 两个设置探针最多占 maxWorkers-1=1 个 worker; 即使第一个挂在失联
    // 网络盘上, 远程新建会话的安全 probe 也不排队, 直接用保留槽 — 不会把
    // 5s 预算耗在排队上而误报 REMOTE_WORKDIR_UNAVAILABLE。
    const { client, children } = createClient();

    const hung = client.validate('/share/dead', '/share/dead', 5_000);
    const hungFailure = hung.catch((error) => error);
    const queuedSettings = client.availability('/share/dead2', '/share/dead2', 5_000);
    const queuedFailure = queuedSettings.catch((error) => error);
    expect(children).toHaveLength(1);

    const safety = client.probe('/remote/healthy', '/remote/healthy', 5_000);
    expect(children).toHaveLength(2);
    expect(children[1].posted[0]).toMatchObject({ kind: 'probe', dir: '/remote/healthy' });
    children[1].respond();
    await expect(safety).resolves.toEqual({ ok: true, isDirectory: true });

    // 安全 probe 结论到手时, 挂死的设置探针与排队的设置探针均未影响它。
    expect(children[0].posted).toHaveLength(1);
    expect(hungFailure).toBeInstanceOf(Promise);
    expect(queuedFailure).toBeInstanceOf(Promise);
    client.dispose();
  });

  it('队列同时有设置类与安全 probe 时, 释放的槽优先服务 probe', async () => {
    const { client, children } = createClient();

    const settingsA = client.validate('/share/a', '/share/a', 5_000); // worker1, 设置容量占满
    const busyProbe = client.probe('/share/busy', '/share/busy', 5_000); // worker2
    expect(children).toHaveLength(2);
    const queuedSettings = client.availability('/share/b', '/share/b', 5_000); // 容量满 → 排队(在前)
    const queuedProbe = client.probe('/remote/next', '/remote/next', 5_000); // 无空闲槽 → 排队(在后)

    // worker2 释放: 必须先启动排在后面的 probe, 而不是排在前面的设置探针。
    respond(children[1], 0, { ok: true, isDirectory: true });
    await expect(busyProbe).resolves.toEqual({ ok: true, isDirectory: true });
    expect(children[1].posted[1]).toMatchObject({ kind: 'probe', dir: '/remote/next' });
    expect(children[0].posted).toHaveLength(1); // 设置探针仍在队列

    // 设置容量释放(worker1 归还)后, 排队的设置探针才启动 — probe 优先不造成
    // 设置类饥饿。
    respond(children[0], 0, { ok: true, realPath: '/resolved' });
    await expect(settingsA).resolves.toEqual({ ok: true, realPath: '/resolved' });
    expect(children[0].posted[1]).toMatchObject({ kind: 'availability', dir: '/share/b' });

    respond(children[0], 1, { ok: true, usable: true });
    respond(children[1], 1, { ok: true, isDirectory: true });
    await expect(queuedSettings).resolves.toEqual({ ok: true, usable: true });
    await expect(queuedProbe).resolves.toEqual({ ok: true, isDirectory: true });
    client.dispose();
  });

  it('设置 job 超时且进程未确认退出时, 保留槽不转移给新设置 job', async () => {
    // terminating worker 在 exit 前仍占 maxWorkers 名额 — 它若原是设置 job,
    // 保留容量必须继续被占用: 新设置 job 排队, 不得创建第二个 worker 吃掉
    // 远程 probe 的保留槽; 直到 exit 确认后设置才可运行。
    vi.useFakeTimers();
    const { client, children } = createClient();

    const hung = client.validate('/share/dead', '/share/dead', 100);
    const hungFailure = hung.catch((error) => error);
    children[0].killResult = false; // kill 未确认, 进程滞留
    await vi.advanceTimersByTimeAsync(100);
    await expect(hungFailure).resolves.toMatchObject({ code: 'WORKDIR_PROBE_TIMEOUT' });
    expect(children).toHaveLength(1);

    const blockedSettings = client.availability('/share/blocked', '/share/blocked', 5_000);
    expect(children).toHaveLength(1); // 不为设置类新建第二个 worker

    const safety = client.probe('/remote/healthy', '/remote/healthy', 5_000);
    expect(children).toHaveLength(2);
    expect(children[1].posted[0]).toMatchObject({ kind: 'probe', dir: '/remote/healthy' });
    children[1].respond();
    await expect(safety).resolves.toEqual({ ok: true, isDirectory: true });

    // 未确认退出期间, 空闲的保留槽也不交给设置类(occupancy 仍含 terminating)。
    expect(children[1].posted).toHaveLength(1);

    children[0].emit('exit', 0);
    expect(children[1].posted[1]).toMatchObject({ kind: 'availability', dir: '/share/blocked' });
    respond(children[1], 1, { ok: true, usable: true });
    await expect(blockedSettings).resolves.toEqual({ ok: true, usable: true });
    client.dispose();
  });

  it('terminating 的 probe worker 同样收紧设置容量(不扩大未确认退出的故障半径)', async () => {
    // 若只按「terminating 前的 job 类型」计数, 挂死的 probe 留下的空槽会被
    // 可选设置占走, 后续远程 probe 反而无槽 — 未确认退出的故障半径被设置
    // 放大。任何 terminating worker 都收紧设置容量。
    vi.useFakeTimers();
    const { client, children } = createClient();

    const hungProbe = client.probe('/share/dead', '/share/dead', 100);
    const hungFailure = hungProbe.catch((error) => error);
    children[0].killResult = false;
    await vi.advanceTimersByTimeAsync(100);
    await expect(hungFailure).resolves.toMatchObject({ code: 'WORKDIR_PROBE_TIMEOUT' });

    const blockedSettings = client.validate('/share/pick', '/share/pick', 5_000);
    expect(children).toHaveLength(1);

    const safety = client.probe('/remote/healthy', '/remote/healthy', 5_000);
    expect(children).toHaveLength(2);
    expect(children[1].posted[0]).toMatchObject({ kind: 'probe', dir: '/remote/healthy' });
    children[1].respond();
    await expect(safety).resolves.toEqual({ ok: true, isDirectory: true });

    children[0].emit('exit', 0);
    expect(children[1].posted[1]).toMatchObject({ kind: 'validate', dir: '/share/pick' });
    respond(children[1], 1, { ok: true, realPath: '/share/pick' });
    await expect(blockedSettings).resolves.toEqual({ ok: true, realPath: '/share/pick' });
    client.dispose();
  });

  it('队列满时, 可立即运行的 probe 不被 queue-full 拒绝; 新设置 job 仍被硬拒', async () => {
    // 容量隔离下可能「设置 active + 设置队列满 + 保留槽空闲」: probe 本可
    // 立即启动, 不得先撞 queue-full; 上限只拦确实需要排队的请求。
    const { client, children } = createClient({ maxWorkers: 2, maxQueued: 1 });

    const activeSettings = client.validate('/share/a', '/share/a', 5_000);
    const queuedSettings = client.availability('/share/b', '/share/b', 5_000);
    expect(children).toHaveLength(1);

    const safety = client.probe('/remote/healthy', '/remote/healthy', 5_000);
    expect(children).toHaveLength(2);
    expect(children[1].posted[0]).toMatchObject({ kind: 'probe', dir: '/remote/healthy' });
    children[1].respond();
    await expect(safety).resolves.toEqual({ ok: true, isDirectory: true });

    // 队列仍满且设置容量已占: 新设置 job 按原语义被 queue-full 拒绝。
    const rejected = client.validate('/share/c', '/share/c', 5_000);
    await expect(rejected).rejects.toMatchObject({ code: 'WORKDIR_PROBE_UNAVAILABLE' });

    respond(children[0], 0, { ok: true, realPath: '/resolved' });
    await expect(activeSettings).resolves.toEqual({ ok: true, realPath: '/resolved' });
    expect(children[0].posted[1]).toMatchObject({ kind: 'availability', dir: '/share/b' });
    respond(children[0], 1, { ok: true, usable: true });
    await expect(queuedSettings).resolves.toEqual({ ok: true, usable: true });
    client.dispose();
  });
});
