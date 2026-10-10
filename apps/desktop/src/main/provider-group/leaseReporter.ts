/**
 * 向组所在电脑报告这台电脑经它的组运行、正在跑的任务(docs/product-rules/provider-groups.md §5)：
 * 任务由这台电脑直接连到组内电脑，组所在电脑看不到，只能靠这里报告，它的「最少占用」与并发上限才算得准。
 *
 * - 任务开始 / 结束一轮时防抖后报告；有任务在跑时每分钟再报一次(组所在电脑 150s 收不到就作废)；
 * - 每次报告是这台电脑在那台组上的完整一份，序号只增(按时间生成，重启后仍比之前大)；
 * - 只用于分摊负载，报告失败只记日志，不影响任务。
 */
import type { ProviderGroupRemoteLease } from '../../shared/providerGroup.js';
import type { ProviderGroupBinding } from './bindings.js';

export const PROVIDER_GROUP_LEASE_DEBOUNCE_MS = 1_000;
export const PROVIDER_GROUP_LEASE_HEARTBEAT_MS = 60_000;

export interface ProviderGroupLeaseReporterDeps {
  listRemoteBindings(): Record<string, ProviderGroupBinding>;
  isTurnRunning(sessionId: string): boolean;
  send(ownerDeviceId: string, seq: number, entries: ProviderGroupRemoteLease[]): Promise<void>;
  now(): number;
  log: { warn(message: string, meta?: Record<string, unknown>): void };
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface ProviderGroupLeaseReporter {
  /** 某个任务开始或结束了一轮(或被关闭)。 */
  notify(sessionId: string): void;
  dispose(): void;
}

export function createProviderGroupLeaseReporter(deps: ProviderGroupLeaseReporterDeps): ProviderGroupLeaseReporter {
  const schedule = deps.setTimeout ?? ((fn, ms) => {
    const timer = setTimeout(fn, ms);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  });
  const cancel = deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  /** 上次报给每台组所在电脑的内容(按序列化比较)；报过空的就不再重复报空。 */
  const lastSent = new Map<string, string>();
  let counter = 0;
  let debounce: unknown = null;
  let heartbeat: unknown = null;
  let disposed = false;

  function nextSeq(): number {
    counter = (counter + 1) % 1000;
    return deps.now() * 1000 + counter;
  }

  function collect(): Map<string, ProviderGroupRemoteLease[]> {
    const byOwner = new Map<string, ProviderGroupRemoteLease[]>();
    for (const [sessionId, binding] of Object.entries(deps.listRemoteBindings())) {
      if (!binding.groupDeviceId) continue;
      const entries = byOwner.get(binding.groupDeviceId) ?? [];
      if (deps.isTurnRunning(sessionId)) entries.push({ sessionId, providerId: binding.providerId, memberKey: binding.memberKey });
      byOwner.set(binding.groupDeviceId, entries);
    }
    return byOwner;
  }

  function flush(force: boolean): void {
    if (disposed) return;
    const byOwner = collect();
    // 之前报过、现在已经没有绑定的组所在电脑：补报一次空，让它立刻放掉。
    for (const owner of lastSent.keys()) if (!byOwner.has(owner)) byOwner.set(owner, []);
    let anyRunning = false;
    for (const [owner, entries] of byOwner) {
      entries.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
      const serialized = JSON.stringify(entries);
      if (entries.length) anyRunning = true;
      const previous = lastSent.get(owner);
      if (previous === undefined && !entries.length) continue;
      if (!force && previous === serialized) continue;
      if (!entries.length) lastSent.delete(owner);
      else lastSent.set(owner, serialized);
      void deps.send(owner, nextSeq(), entries).catch((error) => {
        // 下次心跳或下一次变化时重报：清掉记录，避免以为已经报过。空报告也要能重试——最后一个
        // 经组任务结束时发的就是空报告，失败不重试的话组所在电脑会把已结束的任务一直计入负载。
        lastSent.set(owner, '');
        deps.log.warn('provider group: reporting running tasks failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        scheduleRetry();
      });
    }
    if (heartbeat !== null) {
      cancel(heartbeat);
      heartbeat = null;
    }
    if (anyRunning) scheduleRetry();
  }

  /** 挂一次心跳重试：失败的报告(含空报告)没有任务在跑时也要重发。 */
  function scheduleRetry(): void {
    if (disposed || heartbeat !== null) return;
    heartbeat = schedule(() => {
      heartbeat = null;
      flush(true);
    }, PROVIDER_GROUP_LEASE_HEARTBEAT_MS);
  }

  return {
    notify() {
      if (disposed || debounce !== null) return;
      debounce = schedule(() => {
        debounce = null;
        flush(false);
      }, PROVIDER_GROUP_LEASE_DEBOUNCE_MS);
    },
    dispose() {
      disposed = true;
      if (debounce !== null) cancel(debounce);
      if (heartbeat !== null) cancel(heartbeat);
      debounce = null;
      heartbeat = null;
    },
  };
}
