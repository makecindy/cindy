import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  activateImAccountBoundary,
  captureImAccountGeneration,
  deactivateImAccountBoundary,
  onImAccountBoundaryActivated,
  runInImAccountGeneration,
  waitForImAccountGenerationIdle,
} from '../accountBoundary';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('IM account boundary', () => {
  afterEach(() => activateImAccountBoundary());

  it('rejects queued work whose generation closed before execution', async () => {
    const token = captureImAccountGeneration();
    expect(token).not.toBeNull();
    const operation = vi.fn(async () => undefined);

    const work = runInImAccountGeneration(token!, operation);
    deactivateImAccountBoundary();

    await expect(work).rejects.toMatchObject({ code: 'IM_ACCOUNT_SCOPE_CLOSED' });
    expect(operation).not.toHaveBeenCalled();
  });

  it('drains a handler admitted by the closing account before teardown continues', async () => {
    const gate = deferred();
    const token = captureImAccountGeneration();
    expect(token).not.toBeNull();
    let started = false;
    const work = runInImAccountGeneration(token!, async () => {
      started = true;
      await gate.promise;
    });
    await vi.waitFor(() => expect(started).toBe(true));

    deactivateImAccountBoundary();
    let drained = false;
    const draining = waitForImAccountGenerationIdle(token!).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    gate.resolve();
    await work;
    await draining;
    expect(drained).toBe(true);
  });

  it('notifies activation listeners only on the closed→open transition', () => {
    // 激活通知是「账号边界 ready」广播的触发源(renderer 据此重拉渠道设置):
    // 只在真实转换时触发一次, 重复 activate 不重复通知, 退订后不再触发。
    deactivateImAccountBoundary();
    const listener = vi.fn();
    const unsubscribe = onImAccountBoundaryActivated(listener);
    try {
      activateImAccountBoundary();
      expect(listener).toHaveBeenCalledTimes(1);
      // 已激活状态下的重复 activate 是 no-op。
      activateImAccountBoundary();
      expect(listener).toHaveBeenCalledTimes(1);

      // 换号重连: 再经历一次 关闭→激活 仍要通知。
      deactivateImAccountBoundary();
      activateImAccountBoundary();
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }

    deactivateImAccountBoundary();
    activateImAccountBoundary();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
