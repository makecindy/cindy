import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DeferredCodexRestartService,
  runMemoryChangeWithCodexRestart,
} from '../deferredCodexRestart.js';
import { CodexCredentialModeSwitchBusyError } from '../../maker-host/codex-credential-switch.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
};

beforeEach(() => {
  vi.useFakeTimers();
  logger.info.mockClear();
  logger.warn.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DeferredCodexRestartService', () => {
  function createService(overrides?: {
    restart?: () => Promise<void>;
    hasBusyLocalCodexSession?: () => boolean;
    listLocalCodexSessionIds?: () => string[];
    onApplied?: (sessionIds: string[]) => void;
  }) {
    const restart = overrides?.restart ?? vi.fn(async () => {});
    const service = new DeferredCodexRestartService({
      restart,
      hasBusyLocalCodexSession: overrides?.hasBusyLocalCodexSession ?? (() => false),
      listLocalCodexSessionIds: overrides?.listLocalCodexSessionIds ?? (() => []),
      onApplied: overrides?.onApplied,
      retryDelayMs: 1_000,
      logger,
    });
    return { service, restart };
  }

  it('settle 边界兑现 pending 重启并收口', async () => {
    const restart = vi.fn(async () => {});
    const { service } = createService({ restart });
    service.schedule('memory-change');
    expect(service.isPending()).toBe(true);
    expect(restart).not.toHaveBeenCalled();

    service.onSessionSettled();
    await vi.runOnlyPendingTimersAsync();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(service.isPending()).toBe(false);

    // 收口后的 settle 不再触发重启
    service.onSessionSettled();
    await vi.runOnlyPendingTimersAsync();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('无 pending 时 settle 不触发重启', async () => {
    const restart = vi.fn(async () => {});
    const { service } = createService({ restart });
    service.onSessionSettled();
    await vi.runOnlyPendingTimersAsync();
    expect(restart).not.toHaveBeenCalled();
  });

  it('登记的 applyRuntime 在重启前执行, 收口后唤醒采集到的会话', async () => {
    const order: string[] = [];
    const restart = vi.fn(async () => {
      order.push('restart');
    });
    const onApplied = vi.fn((ids: string[]) => {
      order.push(`applied:${ids.join(',')}`);
    });
    const { service } = createService({
      restart,
      listLocalCodexSessionIds: () => ['s1', 's2'],
      onApplied,
    });
    service.schedule('memory-change', async () => {
      order.push('runtime');
    });
    service.onSessionSettled();
    await vi.runOnlyPendingTimersAsync();
    expect(order).toEqual(['runtime', 'restart', 'applied:s1,s2']);
    expect(service.isPending()).toBe(false);
  });

  it('applyRuntime 失败只 warn, 重启照常执行(重启是最终收敛)', async () => {
    const restart = vi.fn(async () => {});
    const { service } = createService({ restart });
    service.schedule('memory-change', async () => {
      throw new Error('rpc push failed');
    });
    service.onSessionSettled();
    await vi.runOnlyPendingTimersAsync();
    expect(logger.warn).toHaveBeenCalledWith(
      'deferred memory runtime apply failed; proceeding with restart',
      expect.objectContaining({ error: 'rpc push failed' }),
    );
    expect(restart).toHaveBeenCalledTimes(1);
    expect(service.isPending()).toBe(false);
  });

  it('重复 schedule 合并, applyRuntime 取最后一次登记 (last-write-wins)', async () => {
    const restart = vi.fn(async () => {});
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    const { service } = createService({ restart });
    service.schedule('memory-change', first);
    service.schedule('memory-change', second);
    service.onSessionSettled();
    await vi.runOnlyPendingTimersAsync();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('busy 探测为真时跳过本轮, 空闲后由兜底定时器兑现', async () => {
    const restart = vi.fn(async () => {});
    let busy = true;
    const { service } = createService({
      restart,
      hasBusyLocalCodexSession: () => busy,
    });
    service.schedule('memory-change');
    service.onSessionSettled();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(restart).not.toHaveBeenCalled();
    expect(service.isPending()).toBe(true);

    busy = false;
    await vi.advanceTimersByTimeAsync(1_100);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(service.isPending()).toBe(false);
  });

  it('restart 抛 busy(settle 与新 turn 竞态)时保留 pending 且不刷 warn, 之后重试成功', async () => {
    const restart = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new CodexCredentialModeSwitchBusyError(['s1']))
      .mockResolvedValue(undefined);
    const { service } = createService({ restart });
    service.schedule('memory-change');
    service.onSessionSettled();
    await vi.advanceTimersByTimeAsync(0);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(service.isPending()).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_100);
    expect(restart).toHaveBeenCalledTimes(2);
    expect(service.isPending()).toBe(false);
  });

  it('restart 非 busy 失败时 warn + 保留 pending 交给兜底重试', async () => {
    const restart = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('dispose failed'))
      .mockResolvedValue(undefined);
    const { service } = createService({ restart });
    service.schedule('memory-change');
    service.onSessionSettled();
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.warn).toHaveBeenCalledWith(
      'deferred codex restart failed; will retry',
      expect.objectContaining({ error: 'dispose failed' }),
    );
    expect(service.isPending()).toBe(true);

    await vi.advanceTimersByTimeAsync(1_100);
    expect(restart).toHaveBeenCalledTimes(2);
    expect(service.isPending()).toBe(false);
  });

  it('deps 抛错(owner 边界窗口的 facade)不产生 unhandled rejection, 兜底继续', async () => {
    const restart = vi.fn(async () => {});
    let facadeDown = true;
    const { service } = createService({
      restart,
      hasBusyLocalCodexSession: () => {
        if (facadeDown) throw new Error('App session is switching');
        return false;
      },
    });
    service.schedule('memory-change');
    service.onSessionSettled();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.isPending()).toBe(true);
    expect(restart).not.toHaveBeenCalled();

    facadeDown = false;
    await vi.advanceTimersByTimeAsync(1_100);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(service.isPending()).toBe(false);
  });

  it('applying 串行化: 背靠背 settle 只触发一次 restart', async () => {
    let resolveRestart: () => void = () => {};
    const restart = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRestart = resolve;
        }),
    );
    const { service } = createService({ restart });
    service.schedule('memory-change');
    service.onSessionSettled();
    service.onSessionSettled();
    await Promise.resolve();
    expect(restart).toHaveBeenCalledTimes(1);
    resolveRestart();
    await vi.runOnlyPendingTimersAsync();
    expect(service.isPending()).toBe(false);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('clear(owner 边界)丢弃 pending 与登记的 runtime 变更', async () => {
    const restart = vi.fn(async () => {});
    const runtime = vi.fn(async () => {});
    const { service } = createService({ restart });
    service.schedule('memory-change', runtime);
    service.clear();
    expect(service.isPending()).toBe(false);
    service.onSessionSettled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(restart).not.toHaveBeenCalled();
    expect(runtime).not.toHaveBeenCalled();
  });

  it('in-flight 兑现在 clear 后失效: applyRuntime await 期间 clear → restart 不执行', async () => {
    let resolveRuntime: () => void = () => {};
    const restart = vi.fn(async () => {});
    const onApplied = vi.fn();
    const { service } = createService({ restart, onApplied });
    service.schedule(
      'memory-change',
      () =>
        new Promise<void>((resolve) => {
          resolveRuntime = resolve;
        }),
    );
    service.onSessionSettled();
    await Promise.resolve();
    // runtime 还挂着时 owner 边界 clear —— in-flight 兑现整体失效
    service.clear();
    resolveRuntime();
    await vi.runOnlyPendingTimersAsync();
    expect(restart).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
    expect(service.isPending()).toBe(false);
  });

  it('flushBeforeLocalCodexSessionStart: 空闲时先兑现再返回, 无 pending 时是 no-op', async () => {
    const restart = vi.fn(async () => {});
    const { service } = createService({ restart });
    await service.flushBeforeLocalCodexSessionStart();
    expect(restart).not.toHaveBeenCalled();

    service.schedule('memory-change');
    await service.flushBeforeLocalCodexSessionStart();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(service.isPending()).toBe(false);
  });

  it('flushBeforeLocalCodexSessionStart: 其它会话 busy 时立即放行不阻塞', async () => {
    const restart = vi.fn(async () => {});
    const { service } = createService({
      restart,
      hasBusyLocalCodexSession: () => true,
    });
    service.schedule('memory-change');
    await service.flushBeforeLocalCodexSessionStart();
    expect(restart).not.toHaveBeenCalled();
    expect(service.isPending()).toBe(true);
  });

  it('旧 runtime await 期间新 schedule: 循环接着应用新闭包, 不被旧闭包收口误清', async () => {
    const order: string[] = [];
    let resolveFirst: () => void = () => {};
    const restart = vi.fn(async () => {
      order.push('restart');
    });
    const { service } = createService({ restart });
    service.schedule(
      'memory-change',
      () =>
        new Promise<void>((resolve) => {
          order.push('first:start');
          resolveFirst = resolve;
        }),
    );
    service.onSessionSettled();
    await Promise.resolve();
    // 旧 runtime 还挂着时用户再次变更(busy 路径)覆盖登记
    service.schedule('memory-change', async () => {
      order.push('second');
    });
    resolveFirst();
    await vi.runOnlyPendingTimersAsync();
    expect(order).toEqual(['first:start', 'second', 'restart']);
    expect(service.isPending()).toBe(false);
  });

  it('restart await 期间新 schedule: 本轮不收口, 下一边界应用新 runtime 后再重启', async () => {
    const runtimes: string[] = [];
    let resolveRestart: () => void = () => {};
    let restartCalls = 0;
    const restart = vi.fn(() => {
      restartCalls += 1;
      if (restartCalls === 1) {
        return new Promise<void>((resolve) => {
          resolveRestart = resolve;
        });
      }
      return Promise.resolve();
    });
    const { service } = createService({ restart });
    service.schedule('memory-change', async () => {
      runtimes.push('first');
    });
    service.onSessionSettled();
    await Promise.resolve();
    await Promise.resolve();
    // 第一次 restart 还挂着时又来一次变更登记
    service.schedule('memory-change', async () => {
      runtimes.push('second');
    });
    resolveRestart();
    await Promise.resolve();
    await Promise.resolve();
    // 本轮不收口:pending 保持, second 尚未应用
    expect(service.isPending()).toBe(true);
    expect(runtimes).toEqual(['first']);

    service.onSessionSettled();
    await vi.runOnlyPendingTimersAsync();
    expect(runtimes).toEqual(['first', 'second']);
    expect(restart).toHaveBeenCalledTimes(2);
    expect(service.isPending()).toBe(false);
  });

  it('listGatedSessionIds: pending 时返回 live 会话名单, 无 pending / deps 抛错时为空', () => {
    const { service } = createService({
      listLocalCodexSessionIds: () => ['s1', 's2'],
    });
    expect(service.listGatedSessionIds()).toEqual([]);
    service.schedule('memory-change');
    expect(service.listGatedSessionIds()).toEqual(['s1', 's2']);

    const { service: throwing } = createService({
      listLocalCodexSessionIds: () => {
        throw new Error('App session is switching');
      },
    });
    throwing.schedule('memory-change');
    expect(throwing.listGatedSessionIds()).toEqual([]);
  });
});

describe('runMemoryChangeWithCodexRestart', () => {
  function createDeps() {
    return {
      prepare: vi.fn(async () => {}),
      finalize: vi.fn(async () => {}),
      cancel: vi.fn(),
      scheduleDeferredRestart: vi.fn(),
      clearDeferredRestart: vi.fn(),
      logger,
    };
  }

  it('prepare 成功: persist → applyRuntime → finalize, 不登记延迟重启, 清掉旧登记', async () => {
    const deps = createDeps();
    const order: string[] = [];
    const result = await runMemoryChangeWithCodexRestart(deps, {
      persist: async () => {
        order.push('persist');
        return { value: 1 };
      },
      applyRuntime: async () => {
        order.push('runtime');
      },
    });
    expect(result).toEqual({ value: 1, codexRestartDeferred: false });
    expect(order).toEqual(['persist', 'runtime']);
    expect(deps.finalize).toHaveBeenCalledTimes(1);
    expect(deps.cancel).not.toHaveBeenCalled();
    expect(deps.scheduleDeferredRestart).not.toHaveBeenCalled();
    // 立即路径成功后必须丢弃旧的延迟登记 —— 旧 applyRuntime 不能再回放旧设置
    expect(deps.clearDeferredRestart).toHaveBeenCalledTimes(1);
  });

  it('立即路径 finalize 失败也要清旧登记(设置已提交, 旧 applyRuntime 不得回放)', async () => {
    const deps = createDeps();
    deps.finalize.mockRejectedValueOnce(new Error('restart failed'));
    const result = await runMemoryChangeWithCodexRestart(deps, {
      persist: async () => ({ value: 4 }),
      applyRuntime: async () => {},
    });
    expect(result).toEqual({ value: 4, codexRestartDeferred: false });
    expect(deps.clearDeferredRestart).toHaveBeenCalledTimes(1);
  });

  it('立即路径 persist/applyRuntime 失败: 不清旧登记(变更未完成, 旧登记仍有效)', async () => {
    const deps = createDeps();
    await expect(
      runMemoryChangeWithCodexRestart(deps, {
        persist: async () => ({ value: 5 }),
        applyRuntime: async () => {
          throw new Error('rpc failed');
        },
      }),
    ).rejects.toThrow('rpc failed');
    expect(deps.clearDeferredRestart).not.toHaveBeenCalled();
  });

  it('prepare busy: persist 照常提交, applyRuntime 不立即执行而是随登记延迟', async () => {
    const deps = createDeps();
    deps.prepare.mockRejectedValueOnce(new CodexCredentialModeSwitchBusyError(['s1', 's2']));
    const applyRuntime = vi.fn(async () => {});
    const result = await runMemoryChangeWithCodexRestart(deps, {
      persist: async () => ({ value: 2 }),
      applyRuntime,
    });
    expect(result).toEqual({ value: 2, codexRestartDeferred: true });
    expect(applyRuntime).not.toHaveBeenCalled();
    expect(deps.scheduleDeferredRestart).toHaveBeenCalledWith('memory-change', applyRuntime);
    expect(deps.finalize).not.toHaveBeenCalled();
    expect(deps.cancel).not.toHaveBeenCalled();
  });

  it('prepare 非 busy 失败: 原样上抛, 不提交 persist、不登记延迟重启', async () => {
    const deps = createDeps();
    deps.prepare.mockRejectedValueOnce(new Error('close session failed'));
    const persist = vi.fn(async () => ({ value: 9 }));
    await expect(
      runMemoryChangeWithCodexRestart(deps, {
        persist,
        applyRuntime: async () => {},
      }),
    ).rejects.toThrow('close session failed');
    expect(persist).not.toHaveBeenCalled();
    expect(deps.scheduleDeferredRestart).not.toHaveBeenCalled();
    expect(deps.finalize).not.toHaveBeenCalled();
    expect(deps.cancel).not.toHaveBeenCalled();
  });

  it('prepare busy 且 persist 失败: 原样上抛, 不登记延迟重启', async () => {
    const deps = createDeps();
    deps.prepare.mockRejectedValueOnce(new CodexCredentialModeSwitchBusyError(['s1']));
    await expect(
      runMemoryChangeWithCodexRestart(deps, {
        persist: async () => {
          throw new Error('write failed');
        },
        applyRuntime: async () => {},
      }),
    ).rejects.toThrow('write failed');
    expect(deps.scheduleDeferredRestart).not.toHaveBeenCalled();
  });

  it('prepare 成功但 persist 失败: cancel 释放 guard, 不 finalize', async () => {
    const deps = createDeps();
    await expect(
      runMemoryChangeWithCodexRestart(deps, {
        persist: async () => {
          throw new Error('write failed');
        },
        applyRuntime: async () => {},
      }),
    ).rejects.toThrow('write failed');
    expect(deps.cancel).toHaveBeenCalledTimes(1);
    expect(deps.finalize).not.toHaveBeenCalled();
  });

  it('prepare 成功但 applyRuntime 失败: cancel 释放 guard, 不 finalize', async () => {
    const deps = createDeps();
    await expect(
      runMemoryChangeWithCodexRestart(deps, {
        persist: async () => ({ value: 3 }),
        applyRuntime: async () => {
          throw new Error('rpc failed');
        },
      }),
    ).rejects.toThrow('rpc failed');
    expect(deps.cancel).toHaveBeenCalledTimes(1);
    expect(deps.finalize).not.toHaveBeenCalled();
  });

  it('finalize 失败只 warn, 设置提交结果照常返回', async () => {
    const deps = createDeps();
    deps.finalize.mockRejectedValueOnce(new Error('restart failed'));
    const result = await runMemoryChangeWithCodexRestart(deps, {
      persist: async () => ({ value: 3 }),
      applyRuntime: async () => {},
    });
    expect(result).toEqual({ value: 3, codexRestartDeferred: false });
    expect(logger.warn).toHaveBeenCalledWith(
      'codex restart failed after memory setting change',
      expect.objectContaining({ error: 'restart failed' }),
    );
  });
});
