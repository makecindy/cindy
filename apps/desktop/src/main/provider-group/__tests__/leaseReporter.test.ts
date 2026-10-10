/**
 * 向组所在电脑报告经它的组正在运行的任务(provider-groups.md §5)：变化时防抖报告、运行期间心跳、
 * 结束后补报一次空，序号只增。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderGroupBinding } from '../bindings';
import {
  createProviderGroupLeaseReporter,
  PROVIDER_GROUP_LEASE_DEBOUNCE_MS,
  PROVIDER_GROUP_LEASE_HEARTBEAT_MS,
} from '../leaseReporter';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const bindings: Record<string, ProviderGroupBinding> = {
    s1: { providerId: 'anthropic', memberKey: 'device:studio:a', groupDeviceId: 'mini', at: 1 },
    s2: { providerId: 'anthropic', memberKey: 'local', groupDeviceId: 'mini', at: 1 },
    s3: { providerId: 'openai', memberKey: 'local', groupDeviceId: 'other', at: 1 },
  };
  const running = new Set<string>();
  const send = vi.fn(async (...args: [string, number, unknown[]]) => {
    void args;
  });
  const reporter = createProviderGroupLeaseReporter({
    listRemoteBindings: () => bindings,
    isTurnRunning: (id) => running.has(id),
    send,
    now: () => Date.now(),
    log: { warn: vi.fn() },
  });
  return { reporter, running, send, bindings };
}

describe('provider group lease reporter', () => {
  it('reports the running tasks per group computer after a short debounce', async () => {
    const { reporter, running, send } = setup();
    running.add('s1');
    reporter.notify('s1');
    reporter.notify('s1');
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_LEASE_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('mini', expect.any(Number), [
      { sessionId: 's1', providerId: 'anthropic', memberKey: 'device:studio:a' },
    ]);
    reporter.dispose();
  });

  it('sends a heartbeat while tasks run and one empty report once they stop', async () => {
    const { reporter, running, send } = setup();
    running.add('s1');
    reporter.notify('s1');
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_LEASE_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_LEASE_HEARTBEAT_MS);
    expect(send).toHaveBeenCalledTimes(2);
    running.clear();
    reporter.notify('s1');
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_LEASE_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith('mini', expect.any(Number), []);
    // 都停了：不再心跳，也不重复报空。
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_LEASE_HEARTBEAT_MS * 3);
    reporter.notify('s2');
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_LEASE_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(3);
    reporter.dispose();
  });

  it('numbers reports so a later one always has a larger sequence, even across restarts', async () => {
    const { reporter, running, send } = setup();
    running.add('s1');
    reporter.notify('s1');
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_LEASE_DEBOUNCE_MS);
    running.add('s2');
    reporter.notify('s2');
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_LEASE_DEBOUNCE_MS);
    const seqs = send.mock.calls.map((call) => call[1] as number);
    expect(seqs[1]).toBeGreaterThan(seqs[0]);
    reporter.dispose();
    const restarted = setup();
    restarted.running.add('s1');
    restarted.reporter.notify('s1');
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_LEASE_DEBOUNCE_MS);
    expect(restarted.send.mock.calls[0][1] as number).toBeGreaterThan(seqs[1]);
    restarted.reporter.dispose();
  });

  it('retries the empty end-of-round report when sending it fails', async () => {
    const { reporter, running, send } = setup();
    running.add('s1');
    reporter.notify('s1');
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_LEASE_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(1);
    // 最后一个经组任务结束，收尾的空报告发送失败。
    running.clear();
    send.mockRejectedValueOnce(new Error('link down'));
    reporter.notify('s1');
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_LEASE_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(2);
    // 没有任务在跑也要重试：否则组所在电脑会把已结束的任务一直计入负载(150s 才作废)。
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_LEASE_HEARTBEAT_MS);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith('mini', expect.any(Number), []);
    // 报成功之后不再重复报空。
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_LEASE_HEARTBEAT_MS * 3);
    expect(send).toHaveBeenCalledTimes(3);
    reporter.dispose();
  });

  it('does nothing when no task runs through a group on another computer', async () => {
    const { reporter, send } = setup();
    reporter.notify('s1');
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_LEASE_HEARTBEAT_MS);
    expect(send).not.toHaveBeenCalled();
    reporter.dispose();
  });
});
