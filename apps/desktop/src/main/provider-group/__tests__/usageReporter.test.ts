/**
 * 向组所在电脑报告经它的组、在组里别的电脑上运行的用量(provider-groups.md §7)：启动后整份报一次，
 * 记账后防抖报从那天起的一份；送不到退避重报，旧版本隔得更久再试。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderGroupRemoteUsageRow } from '../../../shared/providerGroup';
import { ProviderGroupRemoteUnsupportedError } from '../remoteClient';
import {
  createProviderGroupUsageReporter,
  PROVIDER_GROUP_USAGE_DEBOUNCE_MS,
  PROVIDER_GROUP_USAGE_RETRY_MIN_MS,
  PROVIDER_GROUP_USAGE_STARTUP_DELAY_MS,
  PROVIDER_GROUP_USAGE_UNSUPPORTED_RETRY_MS,
} from '../usageReporter';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const row = (day: string, input = 1): ProviderGroupRemoteUsageRow => ({
  day, providerId: 'anthropic', memberKey: 'device:studio:a', kind: 'claude-code', model: 'opus',
  turns: 1, inputTokens: input, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0, lastAt: 1,
});

function setup(owners: string[] = []) {
  const ledger: Record<string, ProviderGroupRemoteUsageRow[]> = { mini: [row('2026-10-10'), row('2026-10-11')] };
  const send = vi.fn(async (_owner: string, _report: { seq: number; sinceDay: string | null; rows: ProviderGroupRemoteUsageRow[] }) => undefined);
  const warn = vi.fn();
  const reporter = createProviderGroupUsageReporter({
    owners: () => owners,
    rows: (owner, sinceDay) => (ledger[owner] ?? []).filter((item) => !sinceDay || item.day >= sinceDay),
    send,
    now: () => Date.now(),
    log: { warn },
  });
  return { reporter, send, warn, ledger };
}

describe('provider group usage reporter', () => {
  it('reports everything once after start, then the days that changed after a short debounce', async () => {
    const { reporter, send } = setup(['mini']);
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_STARTUP_DELAY_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1]).toMatchObject({ sinceDay: null, rows: [row('2026-10-10'), row('2026-10-11')] });

    reporter.notify('mini', '2026-10-11');
    reporter.notify('mini', '2026-10-11');
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![1]).toMatchObject({ sinceDay: '2026-10-11', rows: [row('2026-10-11')] });
    // 序号只增。
    expect(send.mock.calls[1]![1].seq).toBeGreaterThan(send.mock.calls[0]![1].seq);
    reporter.dispose();
  });

  it('校时让时间戳倒退时序号仍然只增，不被组所在电脑误当重复报告丢弃(greptile-apps P2, PR #5792 review)', async () => {
    let now = 1_000_000;
    const ledger: Record<string, ProviderGroupRemoteUsageRow[]> = { mini: [row('2026-10-10'), row('2026-10-11')] };
    const send = vi.fn(async (_owner: string, _report: { seq: number; sinceDay: string | null; rows: ProviderGroupRemoteUsageRow[] }) => undefined);
    const reporter = createProviderGroupUsageReporter({
      owners: () => ['mini'],
      rows: (owner, sinceDay) => (ledger[owner] ?? []).filter((item) => !sinceDay || item.day >= sinceDay),
      send,
      now: () => now,
      log: { warn: vi.fn() },
    });
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_STARTUP_DELAY_MS);
    expect(send).toHaveBeenCalledTimes(1);
    const firstSeq = send.mock.calls[0]![1].seq;

    // 自动校时把系统时间改回了更早的点。
    now -= 10_000;
    reporter.notify('mini', '2026-10-11');
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![1].seq).toBeGreaterThan(firstSeq);
    reporter.dispose();
  });

  it('跨进程重启仍能接上:持久化的上一次已用序号做底线，重启后即使时间还没赶上也不回头(greptile-apps P2, PR #5792 review)', async () => {
    const persisted = { last: 999_999_999 };
    const send = vi.fn(async (_owner: string, _report: { seq: number; sinceDay: string | null; rows: ProviderGroupRemoteUsageRow[] }) => undefined);
    const reporter = createProviderGroupUsageReporter({
      owners: () => ['mini'],
      rows: () => [row('2026-10-11')],
      send,
      // 重启后系统时间还很早，按时间戳算的序号远远小于持久化的上一次。
      now: () => 1,
      log: { warn: vi.fn() },
      loadLastSeq: () => persisted.last,
      saveLastSeq: (seq) => { persisted.last = seq; },
    });
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_STARTUP_DELAY_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1].seq).toBeGreaterThan(999_999_999);
    reporter.dispose();
  });

  it('retries with backoff when the report does not get through, keeping the earliest day', async () => {
    const { reporter, send, warn } = setup();
    send.mockRejectedValueOnce(new Error('[REMOTE_AGENT_UNAVAILABLE] offline'));
    reporter.notify('mini', '2026-10-11');
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    // 等重试期间又记了更早一天的(跨午夜)：到点一起报，不提前。
    reporter.notify('mini', '2026-10-10');
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_RETRY_MIN_MS);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![1]).toMatchObject({ sinceDay: '2026-10-10' });
    reporter.dispose();
  });

  it('waits much longer before trying an older group computer again', async () => {
    const { reporter, send } = setup();
    send.mockRejectedValueOnce(new ProviderGroupRemoteUnsupportedError());
    reporter.notify('mini', '2026-10-11');
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_UNSUPPORTED_RETRY_MS - 1_000);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(send).toHaveBeenCalledTimes(2);
    reporter.dispose();
  });

  it('sends what changed during a report right after it', async () => {
    const { reporter, send } = setup();
    let finish!: () => void;
    send.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
      finish = () => resolve(undefined);
    }));
    reporter.notify('mini', '2026-10-11');
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_DEBOUNCE_MS);
    reporter.notify('mini', '2026-10-11');
    finish();
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(2);
    reporter.dispose();
  });

  it('单日超过 3000 行仍发送完整报告，失败后从原起始日重报', async () => {
    const { reporter, send, ledger } = setup(['mini']);
    ledger.mini = [row('2026-10-10'), ...Array.from({ length: 3001 }, (_, i) => ({ ...row('2026-10-11'), model: `model-${i}` }))];
    send.mockRejectedValueOnce(new Error('part transfer interrupted'));
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_STARTUP_DELAY_MS);
    expect(send.mock.calls[0]![1]).toMatchObject({ sinceDay: null, rows: ledger.mini });
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_RETRY_MIN_MS);
    expect(send.mock.calls[1]![1]).toMatchObject({ sinceDay: null, rows: ledger.mini });
    expect(send.mock.calls[1]![1].seq).toBeGreaterThan(send.mock.calls[0]![1].seq);
    reporter.dispose();
  });
});
