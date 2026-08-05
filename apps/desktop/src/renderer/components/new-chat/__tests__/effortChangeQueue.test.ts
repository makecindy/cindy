import { describe, expect, it, vi } from 'vitest';

import type { Effort } from '@/lib/userPreferences.types';
import {
  createEffortChangeCoordinator,
  enqueueEffortChange,
  isSessionScopeCurrent,
} from '../effortChangeQueue';

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('effort change coordinator', () => {
  it('快速 high → xhigh → high → xhigh 后 DB、runtime 与 Renderer 都以最后一次点击为准', async () => {
    const coordinator = createEffortChangeCoordinator();
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const efforts: Effort[] = ['high', 'xhigh', 'high', 'xhigh'];
    const events: string[] = [];
    let persistIndex = 0;
    let databaseEffort: Effort = 'high';
    let runtimeEffort: Effort = 'high';
    let renderedEffort: Effort = 'high';

    const pipeline = {
      persist: vi.fn(async (_sessionId: string, effort: Effort) => {
        const gate = gates[persistIndex];
        persistIndex += 1;
        events.push(`db:${effort}:start`);
        await gate.promise;
        databaseEffort = effort;
        events.push(`db:${effort}:done`);
      }),
      applyRuntime: vi.fn(async (_sessionId: string, effort: Effort) => {
        runtimeEffort = effort;
        events.push(`runtime:${effort}`);
      }),
      onCommitted: vi.fn((_sessionId: string, effort: Effort) => {
        renderedEffort = effort;
        events.push(`renderer:${effort}`);
      }),
    };

    const writes = efforts.map((effort) =>
      enqueueEffortChange(coordinator, 'session-a', effort, pipeline),
    );

    await vi.waitFor(() => {
      expect(pipeline.persist).toHaveBeenCalledTimes(1);
    });

    for (let index = 0; index < gates.length; index += 1) {
      gates[index].resolve();
      await writes[index];
      expect(databaseEffort).toBe(efforts[index]);
      expect(runtimeEffort).toBe(efforts[index]);
      expect(renderedEffort).toBe(efforts[index]);
      if (index + 1 < gates.length) {
        await vi.waitFor(() => {
          expect(pipeline.persist).toHaveBeenCalledTimes(index + 2);
        });
      }
    }

    await Promise.all(writes);
    expect(events).toEqual(
      efforts.flatMap((effort) => [
        `db:${effort}:start`,
        `db:${effort}:done`,
        `renderer:${effort}`,
        `runtime:${effort}`,
      ]),
    );
    expect(databaseEffort).toBe('xhigh');
    expect(runtimeEffort).toBe('xhigh');
    expect(renderedEffort).toBe('xhigh');
  });

  it('runtime 永不 settle 时仍提交 Renderer 并允许后续 DB 写入', async () => {
    const coordinator = createEffortChangeCoordinator();
    const never = new Promise<void>(() => undefined);
    const persisted: Effort[] = [];
    const rendered: Effort[] = [];
    const pipeline = {
      persist: vi.fn(async (_sessionId: string, effort: Effort) => {
        persisted.push(effort);
      }),
      applyRuntime: vi.fn((_sessionId: string, effort: Effort) =>
        effort === 'high' ? never : Promise.resolve(),
      ),
      onCommitted: vi.fn((_sessionId: string, effort: Effort) => {
        rendered.push(effort);
      }),
    };

    await expect(
      enqueueEffortChange(coordinator, 'session-a', 'high', pipeline),
    ).resolves.toBeUndefined();
    await expect(
      enqueueEffortChange(coordinator, 'session-a', 'xhigh', pipeline),
    ).resolves.toBeUndefined();

    expect(persisted).toEqual(['high', 'xhigh']);
    expect(rendered).toEqual(['high', 'xhigh']);
    expect(pipeline.applyRuntime).toHaveBeenCalledTimes(2);
  });

  it('旧 runtime 晚完成后自动重放最新 effort', async () => {
    const coordinator = createEffortChangeCoordinator();
    const attempts: Array<{ effort: Effort; gate: ReturnType<typeof deferred> }> = [];
    let runtimeEffort: Effort = 'medium';
    const applyRuntime = vi.fn((_sessionId: string, effort: Effort) => {
      const gate = deferred();
      attempts.push({ effort, gate });
      return gate.promise.then(() => {
        runtimeEffort = effort;
      });
    });
    const pipeline = {
      persist: vi.fn(async () => undefined),
      applyRuntime,
      onCommitted: vi.fn(),
    };

    await enqueueEffortChange(coordinator, 'session-a', 'high', pipeline);
    await enqueueEffortChange(coordinator, 'session-a', 'xhigh', pipeline);
    expect(attempts.map(({ effort }) => effort)).toEqual(['high', 'xhigh']);

    attempts[1].gate.resolve();
    await vi.waitFor(() => expect(runtimeEffort).toBe('xhigh'));
    attempts[0].gate.resolve();
    await vi.waitFor(() => expect(applyRuntime).toHaveBeenCalledTimes(3));
    expect(runtimeEffort).toBe('high');
    expect(attempts[2].effort).toBe('xhigh');

    attempts[2].gate.resolve();
    await vi.waitFor(() => expect(runtimeEffort).toBe('xhigh'));
  });

  it('deferred model/provider 可取消 runtime repair，不向仍在运行的旧 turn 重放', async () => {
    const coordinator = createEffortChangeCoordinator();
    const oldAttempt = deferred();
    const applyRuntime = vi.fn(() => oldAttempt.promise);

    coordinator.publishRuntimeEffort('session-a', 'high', applyRuntime);
    coordinator.setCommittedEffort('session-a', 'xhigh');
    coordinator.suppressRuntimeEffort('session-a');
    oldAttempt.resolve();
    await oldAttempt.promise;
    await Promise.resolve();

    expect(applyRuntime).toHaveBeenCalledTimes(1);
    expect(coordinator.getCommittedEffort('session-a')).toBe('xhigh');
  });

  it('effort → model 共用 commit lane，旧 runtime pending 不阻塞 model 终态', async () => {
    const coordinator = createEffortChangeCoordinator();
    const effortPersistGate = deferred();
    const oldRuntime = new Promise<void>(() => undefined);
    const events: string[] = [];
    let databaseEffort: Effort = 'medium';
    let renderedEffort: Effort = 'medium';
    const applyRuntime = vi.fn((_sessionId: string, effort: Effort) =>
      effort === 'high' ? oldRuntime : Promise.resolve(),
    );

    const effortWrite = enqueueEffortChange(coordinator, 'session-a', 'high', {
      persist: async () => {
        events.push('effort-db:start');
        await effortPersistGate.promise;
        databaseEffort = 'high';
        events.push('effort-db:done');
      },
      applyRuntime,
      onCommitted: () => {
        renderedEffort = 'high';
      },
    });
    const modelWrite = coordinator.enqueue('session-a', async () => {
      events.push('model:start');
      databaseEffort = 'xhigh';
      coordinator.setCommittedEffort('session-a', 'xhigh');
      renderedEffort = 'xhigh';
      coordinator.publishRuntimeEffort('session-a', 'xhigh', applyRuntime);
    });

    await Promise.resolve();
    expect(events).toEqual(['effort-db:start']);
    effortPersistGate.resolve();
    await Promise.all([effortWrite, modelWrite]);

    expect(events).toEqual(['effort-db:start', 'effort-db:done', 'model:start']);
    expect(databaseEffort).toBe('xhigh');
    expect(renderedEffort).toBe('xhigh');
    expect(applyRuntime).toHaveBeenNthCalledWith(1, 'session-a', 'high');
    expect(applyRuntime).toHaveBeenNthCalledWith(2, 'session-a', 'xhigh');
  });

  it('effort → 同模型 provider 在 lane 执行时读取最新 committed effort', async () => {
    const coordinator = createEffortChangeCoordinator();
    const effortPersistGate = deferred();
    const clickTimeEffort: Effort = 'high';
    let providerEffort: Effort = clickTimeEffort;

    const effortWrite = enqueueEffortChange(coordinator, 'session-a', 'xhigh', {
      persist: async () => effortPersistGate.promise,
      applyRuntime: async () => undefined,
      onCommitted: () => undefined,
    });
    const providerWrite = coordinator.enqueue('session-a', async () => {
      providerEffort = coordinator.getCommittedEffort('session-a') ?? clickTimeEffort;
    });

    await Promise.resolve();
    effortPersistGate.resolve();
    await Promise.all([effortWrite, providerWrite]);

    expect(providerEffort).toBe('xhigh');
  });

  it('外部 session patch 可在下一次 model/provider 切换前覆盖旧 committed cache', () => {
    const coordinator = createEffortChangeCoordinator();
    const applyRuntime = vi.fn(async () => undefined);
    coordinator.setCommittedEffort('session-a', 'xhigh');

    // 模拟 initialEffort 由其它窗口 / 控制路径的 sessions:patched 更新。没有本地 runtime
    // 目标时只水合 cache，不因组件首次挂载额外触碰 runtime。
    coordinator.adoptExternalEffort('session-a', 'high', applyRuntime);

    expect(coordinator.getCommittedEffort('session-a')).toBe('high');
    expect(applyRuntime).not.toHaveBeenCalled();
  });

  it('外部 session patch 会抢占旧 runtime attempt 并在其迟到完成后修复终态', async () => {
    const coordinator = createEffortChangeCoordinator();
    const attempts: Array<{ effort: Effort; gate: ReturnType<typeof deferred> }> = [];
    let runtimeEffort: Effort = 'medium';
    const applyRuntime = vi.fn((_sessionId: string, effort: Effort) => {
      const gate = deferred();
      attempts.push({ effort, gate });
      return gate.promise.then(() => {
        runtimeEffort = effort;
      });
    });

    coordinator.setCommittedEffort('session-a', 'xhigh');
    coordinator.publishRuntimeEffort('session-a', 'xhigh', applyRuntime);
    coordinator.adoptExternalEffort('session-a', 'high', applyRuntime);

    expect(coordinator.getCommittedEffort('session-a')).toBe('high');
    expect(attempts.map(({ effort }) => effort)).toEqual(['xhigh', 'high']);

    attempts[1].gate.resolve();
    await vi.waitFor(() => expect(runtimeEffort).toBe('high'));
    attempts[0].gate.resolve();
    await vi.waitFor(() => expect(applyRuntime).toHaveBeenCalledTimes(3));
    expect(runtimeEffort).toBe('xhigh');
    expect(attempts[2].effort).toBe('high');

    attempts[2].gate.resolve();
    await vi.waitFor(() => expect(runtimeEffort).toBe('high'));
  });

  it('前一次持久化失败不会发布 runtime、提交 UI 或阻断后续选择', async () => {
    const coordinator = createEffortChangeCoordinator();
    const applied: Effort[] = [];
    const pipeline = {
      persist: vi.fn(async (_sessionId: string, effort: Effort) => {
        if (effort === 'high') throw new Error('db failed');
      }),
      applyRuntime: vi.fn(async () => undefined),
      onCommitted: vi.fn((_sessionId: string, effort: Effort) => {
        applied.push(effort);
      }),
    };

    const first = enqueueEffortChange(coordinator, 'session-a', 'high', pipeline);
    const second = enqueueEffortChange(coordinator, 'session-a', 'xhigh', pipeline);

    await expect(first).rejects.toThrow('db failed');
    await expect(second).resolves.toBeUndefined();
    expect(pipeline.applyRuntime).toHaveBeenCalledTimes(1);
    expect(applied).toEqual(['xhigh']);
  });

  it('A session 的慢 DB/runtime 不阻塞 B session lane', async () => {
    const coordinator = createEffortChangeCoordinator();
    const sessionAGate = deferred();
    const events: string[] = [];

    const sessionA = coordinator.enqueue('session-a', async () => {
      events.push('a:start');
      await sessionAGate.promise;
      events.push('a:done');
    });
    const sessionB = coordinator.enqueue('session-b', async () => {
      events.push('b:done');
    });

    await sessionB;
    expect(events).toEqual(['a:start', 'b:done']);
    sessionAGate.resolve();
    await sessionA;
  });

  it('A provider 迟到完成时不能覆盖当前 B session 的本地 selector state', () => {
    let currentSessionId: string | undefined = 'session-a';
    let selectedProviderId = 'provider-a';
    const applyProviderSelection = (sourceSessionId: string, providerId: string) => {
      if (!isSessionScopeCurrent(sourceSessionId, currentSessionId)) return;
      selectedProviderId = providerId;
    };

    currentSessionId = 'session-b';
    selectedProviderId = 'provider-b';
    applyProviderSelection('session-a', 'provider-a-new');

    expect(selectedProviderId).toBe('provider-b');
  });

  it('远程 A 在 preflight await 期间切到 B 后不能重新锁住 B selector', async () => {
    const preflight = deferred();
    let currentSessionId: string | undefined = 'session-a';
    let remoteSwitchInFlight = false;
    const startRemoteSwitch = async (sourceSessionId: string) => {
      await preflight.promise;
      if (!isSessionScopeCurrent(sourceSessionId, currentSessionId)) return;
      remoteSwitchInFlight = true;
    };

    const pending = startRemoteSwitch('session-a');
    currentSessionId = 'session-b';
    remoteSwitchInFlight = false;
    preflight.resolve();
    await pending;

    expect(remoteSwitchInFlight).toBe(false);
  });
});
