/**
 * sessions:list 单飞：相同账号 + 归一化参数的并发请求共用一次查询。
 *
 * 只合并 in-flight Promise，查完即删，不加 TTL。
 * key 必须用归一化后的 cap / status / includePinned，并带上当前 userId 和写代次。
 * 写代次由 DbClient 写路径与当前库生命周期推进，见 sessionListWriteGeneration。
 */

import {
  bumpSessionListWriteGeneration,
  readSessionListWriteGeneration,
  resetSessionListWriteGenerationForTests,
} from '../client/sessionListWriteGeneration';

export type SessionListStatusFilter = 'active' | 'archived' | null;

export {
  bumpSessionListWriteGeneration,
  readSessionListWriteGeneration,
};

const inflight = new Map<string, Promise<unknown>>();

export function buildSessionListFlightKey(input: {
  userId: string;
  cap: number;
  statusFilter: SessionListStatusFilter;
  includePinned: boolean;
}): string {
  const status = input.statusFilter ?? 'all';
  return `${input.userId}|${status}|${input.cap}|${input.includePinned ? 'pinned' : 'plain'}|g${readSessionListWriteGeneration()}`;
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
  resetSessionListWriteGenerationForTests();
}
