/**
 * sessions:list 单飞：相同账号 + 归一化参数的并发请求共用一次查询。
 *
 * 只合并 in-flight Promise，查完即删，不加 TTL。
 * key 必须用归一化后的 cap / status / includePinned，并带上当前 userId，
 * 否则切账号时新请求会接到旧库那次查询。options 以后若加字段，同步扩 key。
 * 列表成员变化后必须 bump 写代次：新建走 emitSessionCreated，status/pinnedAt
 * 走 broadcastSessionPatched；local-db:sessions:create 插入后单独 bump。
 */

export type SessionListStatusFilter = 'active' | 'archived' | null;

const inflight = new Map<string, Promise<unknown>>();
let writeGeneration = 0;

export function bumpSessionListWriteGeneration(): void {
  writeGeneration += 1;
}

/** 归档 / 删除 / 置顶会改 list 成员；标题等字段变化不必隔开 flight。 */
export function noteSessionListMembershipPatch(patch: Record<string, unknown>): void {
  if (patch.status !== undefined || patch.pinnedAt !== undefined) {
    bumpSessionListWriteGeneration();
  }
}

export function readSessionListWriteGeneration(): number {
  return writeGeneration;
}

export function buildSessionListFlightKey(input: {
  userId: string;
  cap: number;
  statusFilter: SessionListStatusFilter;
  includePinned: boolean;
}): string {
  const status = input.statusFilter ?? 'all';
  return `${input.userId}|${status}|${input.cap}|${input.includePinned ? 'pinned' : 'plain'}|g${writeGeneration}`;
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
  writeGeneration = 0;
}
