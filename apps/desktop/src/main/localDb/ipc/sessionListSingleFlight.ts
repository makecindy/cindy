/**
 * sessions:list 单飞：相同账号 + 同一 DbClient 代次 + 归一化参数的并发请求共用一次查询。
 *
 * 只合并 in-flight Promise，查完即删，不加 TTL。
 * key 必须用归一化后的 cap / status / includePinned，并带上当前 userId 和 clientEpoch，
 * 否则切账号或重登会接到旧库那次查询。options 以后若加字段，同步扩 key。
 *
 * 写后 freshness 不靠写代次：forceRefresh / status 重拉传 fresh，直接绕开单飞。
 */

export type SessionListStatusFilter = 'active' | 'archived' | null;

const inflight = new Map<string, Promise<unknown>>();

export function buildSessionListFlightKey(input: {
  userId: string;
  clientEpoch: number;
  cap: number;
  statusFilter: SessionListStatusFilter;
  includePinned: boolean;
}): string {
  const status = input.statusFilter ?? 'all';
  return `${input.userId}|c${input.clientEpoch}|${status}|${input.cap}|${input.includePinned ? 'pinned' : 'plain'}`;
}

export function runSessionListSingleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  let flight: Promise<T>;
  try {
    flight = Promise.resolve(run()).finally(() => {
      if (inflight.get(key) === flight) inflight.delete(key);
    });
  } catch (err) {
    return Promise.reject(err);
  }
  inflight.set(key, flight);
  return flight;
}

/** 测试用：清空残留 flight，避免用例互相污染。 */
export function resetSessionListSingleFlightForTests(): void {
  inflight.clear();
}
