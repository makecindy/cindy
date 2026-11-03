import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeishuAppRegistrationBegin, FeishuAppRegistrationPoll } from '@cindy/im';

import type { BotImFeishuRegistrationStatus } from '../../../../shared/botImConnection';
import {
  cancelFeishuConnectionRegistration,
  startFeishuConnectionRegistration,
} from '../botImFeishuRegistration';

const begin: FeishuAppRegistrationBegin = {
  deviceCode: 'device-code',
  userCode: 'user-code',
  verificationUrl: 'https://example.test/authorize',
  expiresIn: 600,
  interval: 1,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(
  poll: ReturnType<typeof vi.fn>,
  commit = vi.fn(async () => undefined),
  service: 'feishu' | 'lark' = 'feishu',
) {
  const statuses: BotImFeishuRegistrationStatus[] = [];
  const started = startFeishuConnectionRegistration({
    service,
    request: vi.fn(async () => begin),
    poll: poll as unknown as (
      brand: 'feishu' | 'lark',
      deviceCode: string,
      interval: number,
    ) => Promise<FeishuAppRegistrationPoll>,
    commit,
    isCurrent: () => true,
    onStatus: (status) => statuses.push(status),
  });
  return { started, commit, statuses };
}

beforeEach(() => {
  vi.useFakeTimers();
  cancelFeishuConnectionRegistration();
});

afterEach(async () => {
  // 先作废在途轮次, 再把已排的延时跑掉, 避免结算跑到下一个用例里。
  cancelFeishuConnectionRegistration();
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
});

describe('伙伴飞书扫码授权会话', () => {
  it('commits the registered app once and reports success', async () => {
    const poll = vi.fn(async () => ({
      status: 'success' as const,
      result: {
        clientId: 'cli_registered',
        clientSecret: 'registered-secret',
        tenantBrand: null,
        ownerOpenId: 'ou_owner',
      },
    }));
    const { started, commit, statuses } = setup(poll);

    await expect(started).resolves.toMatchObject({ ok: true, runId: expect.any(Number) });
    await vi.advanceTimersByTimeAsync(1000);

    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'cli_registered',
        clientSecret: 'registered-secret',
        tenantBrand: 'feishu',
      }),
      expect.any(Function),
    );
    expect(statuses.at(-1)).toMatchObject({ status: 'success' });
  });

  it('does not commit after cancel', async () => {
    const poll = vi.fn(async () => ({ status: 'pending' as const }));
    const { started, commit, statuses } = setup(poll);

    await expect(started).resolves.toMatchObject({ ok: true });
    cancelFeishuConnectionRegistration();
    await vi.advanceTimersByTimeAsync(5000);

    expect(commit).not.toHaveBeenCalled();
    expect(statuses.map((item) => item.status)).toContain('cancelled');
    expect(statuses.map((item) => item.status)).not.toContain('success');
  });

  it('drops an old round once a new registration starts', async () => {
    const firstPoll = deferred<FeishuAppRegistrationPoll>();
    const poll = vi.fn(() => firstPoll.promise);
    const firstCommit = vi.fn(async () => undefined);
    const first = setup(poll, firstCommit);

    await expect(first.started).resolves.toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(1);

    // 第二轮开始会作废第一轮; 第一轮此时才完成授权也不能落库。
    const second = setup(vi.fn(async () => ({ status: 'pending' as const })));
    await expect(second.started).resolves.toMatchObject({ ok: true });

    firstPoll.resolve({
      status: 'success',
      result: {
        clientId: 'cli_stale',
        clientSecret: 'stale-secret',
        tenantBrand: 'feishu',
        ownerOpenId: 'ou_stale',
      },
    });
    await vi.advanceTimersByTimeAsync(1000);

    expect(firstCommit).not.toHaveBeenCalled();
  });

  it('switches to Lark immediately when the poll discovers the tenant', async () => {
    const poll = vi
      .fn()
      .mockResolvedValueOnce({ status: 'pending', tenantBrand: 'lark' })
      .mockResolvedValue({ status: 'pending' });
    const { started } = setup(
      poll,
      vi.fn(async () => undefined),
      'feishu',
    );

    await expect(started).resolves.toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(poll).toHaveBeenNthCalledWith(1, 'feishu', 'device-code', 1);
    expect(poll).toHaveBeenNthCalledWith(2, 'lark', 'device-code', 1);
  });

  it('reports an expired round when polling runs out', async () => {
    const poll = vi.fn(async () => ({ status: 'pending' as const }));
    const statuses: BotImFeishuRegistrationStatus[] = [];
    await startFeishuConnectionRegistration({
      service: 'feishu',
      request: async () => ({ ...begin, expiresIn: 2 }),
      poll,
      commit: vi.fn(async () => undefined),
      isCurrent: () => true,
      onStatus: (status) => statuses.push(status),
    });

    await vi.advanceTimersByTimeAsync(5000);

    expect(statuses.at(-1)).toMatchObject({ status: 'expired' });
  });
});
