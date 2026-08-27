import { describe, expect, it, vi } from 'vitest';

import { syncCanaryChannelAfterAuth } from './canaryChannelSync';

function deps(value: unknown, generation = 3) {
  return {
    fetchFeatureFlags: vi.fn(async () => value),
    readCurrentAuthGeneration: vi.fn(() => generation),
    persistFlag: vi.fn(async () => undefined),
  };
}

describe('syncCanaryChannelAfterAuth', () => {
  it.each([true, false])('合法 isCanary=%s 才持久化', async (isCanary) => {
    const d = deps({ isCanary });
    await expect(
      syncCanaryChannelAfterAuth({ token: 't', expectedAuthGeneration: 3 }, d),
    ).resolves.toEqual({ kind: 'synced', isCanary });
    expect(d.persistFlag).toHaveBeenCalledWith(isCanary);
  });

  it('读取可选 beta 默认标记，且不改变 canary 校验', async () => {
    const d = deps({ isCanary: false, defaultEnableBeta: true });
    await expect(
      syncCanaryChannelAfterAuth({ token: 't', expectedAuthGeneration: 3 }, d),
    ).resolves.toEqual({
      kind: 'synced',
      isCanary: false,
      defaultEnableBeta: true,
    });

    const invalid = deps({ isCanary: 'true', defaultEnableBeta: true });
    await expect(
      syncCanaryChannelAfterAuth(
        { token: 't', expectedAuthGeneration: 3 },
        invalid,
      ),
    ).resolves.toEqual({
      kind: 'preserved',
      reason: 'invalid-response',
      defaultEnableBeta: true,
    });
  });

  it.each([false, undefined, 'true', 1])(
    '非 true 的 defaultEnableBeta 不进入 outcome: %j',
    async (defaultEnableBeta) => {
      const outcome = await syncCanaryChannelAfterAuth(
        { token: 't', expectedAuthGeneration: 3 },
        deps({ isCanary: false, defaultEnableBeta }),
      );
      expect(outcome).toEqual({ kind: 'synced', isCanary: false });
      expect(outcome).not.toHaveProperty('defaultEnableBeta', true);
    },
  );

  it('请求失败/非法响应保留旧值', async () => {
    const failed = deps({});
    failed.fetchFeatureFlags.mockRejectedValueOnce(new Error('offline'));
    await expect(
      syncCanaryChannelAfterAuth(
        { token: 't', expectedAuthGeneration: 3 },
        failed,
      ),
    ).resolves.toEqual({ kind: 'preserved', reason: 'request-failed' });
    expect(failed.persistFlag).not.toHaveBeenCalled();
    const failedWithFlag = deps({ defaultEnableBeta: true });
    failedWithFlag.fetchFeatureFlags.mockRejectedValueOnce(
      new Error('offline'),
    );
    const failedOutcome = await syncCanaryChannelAfterAuth(
      { token: 't', expectedAuthGeneration: 3 },
      failedWithFlag,
    );
    expect(failedOutcome).toEqual({
      kind: 'preserved',
      reason: 'request-failed',
    });
    expect(failedOutcome).not.toHaveProperty('defaultEnableBeta');

    const invalid = deps({ isCanary: 'true' });
    await expect(
      syncCanaryChannelAfterAuth(
        { token: 't', expectedAuthGeneration: 3 },
        invalid,
      ),
    ).resolves.toEqual({ kind: 'preserved', reason: 'invalid-response' });
    expect(invalid.persistFlag).not.toHaveBeenCalled();
  });

  it('登出/换账号后的迟到响应不得覆盖', async () => {
    const d = deps({ isCanary: true }, 4);
    await expect(
      syncCanaryChannelAfterAuth(
        { token: 'old', expectedAuthGeneration: 3 },
        d,
      ),
    ).resolves.toEqual({ kind: 'preserved', reason: 'stale-auth' });
    expect(d.persistFlag).not.toHaveBeenCalled();
  });

  it('canary 落盘失败时仍保留 beta 默认标记供非 xd 调度', async () => {
    const d = deps({ isCanary: true, defaultEnableBeta: true });
    d.persistFlag.mockRejectedValueOnce(new Error('storage offline'));
    await expect(
      syncCanaryChannelAfterAuth({ token: 't', expectedAuthGeneration: 3 }, d),
    ).resolves.toEqual({
      kind: 'preserved',
      reason: 'persist-failed',
      defaultEnableBeta: true,
    });
  });
});
