/**
 * 向组所在电脑报告这台电脑经它的组、在组里别的电脑上运行的用量(docs/product-rules/provider-groups.md §7)：
 * 任务由这台电脑直接连到组内电脑，组所在电脑经手不到，「远程与分享」页「自己」那一行要靠这里报告才算得全。
 *
 * - 用量先记进本机按账号的账本(providerPartyUsageStore 的 `group` 行)，这里只负责送到：每台组所在电脑记一个
 *   「从哪天起要重报」，每次报告是那台从这天起的完整一份(对方整体替换)，重复送不会多算；
 * - 记账后防抖再报；启动后先把每台整份报一次，补上上次退出前没送到的；
 * - 送不到(离线、断线)按退避稍后重报；对方是还不认识用量报告的旧版本时隔得更久再试；
 * - 只影响用量显示，失败只记日志，不影响任务。
 */
import type { ProviderGroupRemoteUsageRow } from '../../shared/providerGroup.js';
import { ProviderGroupRemoteUnsupportedError } from './remoteClient.js';

export const PROVIDER_GROUP_USAGE_DEBOUNCE_MS = 5_000;
/** 启动后多久做第一次整份报告(等设备互联连上)。 */
export const PROVIDER_GROUP_USAGE_STARTUP_DELAY_MS = 20_000;
export const PROVIDER_GROUP_USAGE_RETRY_MIN_MS = 30_000;
export const PROVIDER_GROUP_USAGE_RETRY_MAX_MS = 10 * 60_000;
/** 对方是旧版本：隔这么久再试(它可能已经更新)。 */
export const PROVIDER_GROUP_USAGE_UNSUPPORTED_RETRY_MS = 30 * 60_000;
/** 隔多久确认一次当前账号已有报告器(换了账号后据此把新账号还没送到的报上)。 */
export const PROVIDER_GROUP_USAGE_ENSURE_INTERVAL_MS = 10 * 60_000;

export interface ProviderGroupUsageReporterDeps {
  /** 有要报告的用量的组所在电脑。 */
  owners(): string[];
  /** 要报告给那台的行(sinceDay 起，含当天；null = 全部)。 */
  rows(ownerDeviceId: string, sinceDay: string | null): ProviderGroupRemoteUsageRow[];
  send(ownerDeviceId: string, report: { seq: number; sinceDay: string | null; rows: ProviderGroupRemoteUsageRow[] }): Promise<void>;
  now(): number;
  log: { warn(message: string, meta?: Record<string, unknown>): void };
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /**
   * 跳过校时/重启跨进程保证序号只增(greptile-apps P2, PR #5792 review)：读进程重开前还没过期的最大
   * 已用序号；不提供按 0 起(进程内仍单调，只是不跨进程记忆)。
   */
  loadLastSeq?(): number;
  /** 每次生成新序号都落盘，下次进程重启还能接上。失败只影响重启后的起点，本次运行照常单调。 */
  saveLastSeq?(seq: number): void;
}

export interface ProviderGroupUsageReporter {
  /** 刚给某台组所在电脑记了 day 这一天的用量。 */
  notify(ownerDeviceId: string, day: string): void;
  dispose(): void;
}

/** 某台组所在电脑要从哪天起重报：`all` = 整份。 */
type Pending = 'all' | string;

function earlier(a: Pending | undefined, b: Pending): Pending {
  if (a === undefined) return b;
  if (a === 'all' || b === 'all') return 'all';
  return a < b ? a : b;
}

export function createProviderGroupUsageReporter(deps: ProviderGroupUsageReporterDeps): ProviderGroupUsageReporter {
  const schedule = deps.setTimeout ?? ((fn, ms) => {
    const timer = setTimeout(fn, ms);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  });
  const cancel = deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const pending = new Map<string, Pending>();
  const inFlight = new Set<string>();
  const timers = new Map<string, unknown>();
  const failures = new Map<string, number>();
  let counter = 0;
  let disposed = false;
  // 校时或自动校时让系统时间倒退时，基于时间戳的序号可能比之前小，让组所在电脑在去重时误当成重复
  // 报告丢弃(greptile-apps P2, PR #5792 review)。读进程重启前还没过期的最大已用序号做底线，每次生成
  // 都至少比上一次大 1。
  let lastSeq = Math.max(0, deps.loadLastSeq?.() ?? 0);

  function nextSeq(): number {
    counter = (counter + 1) % 1000;
    const candidate = deps.now() * 1000 + counter;
    const seq = candidate > lastSeq ? candidate : lastSeq + 1;
    lastSeq = seq;
    deps.saveLastSeq?.(seq);
    return seq;
  }

  function arm(owner: string, ms: number): void {
    if (disposed) return;
    const existing = timers.get(owner);
    if (existing !== undefined) cancel(existing);
    timers.set(owner, schedule(() => {
      timers.delete(owner);
      void flush(owner);
    }, ms));
  }

  async function flush(owner: string): Promise<void> {
    if (disposed || inFlight.has(owner)) return;
    const since = pending.get(owner);
    if (since === undefined) return;
    pending.delete(owner);
    inFlight.add(owner);
    try {
      const sinceDay = since === 'all' ? null : since;
      // 完整快照由 remoteClient 按帧上限分批发送；不能截断单日或丢掉尚未报告的旧日期。
      await deps.send(owner, { seq: nextSeq(), sinceDay, rows: deps.rows(owner, sinceDay) });
      failures.delete(owner);
    } catch (error) {
      // 没送到：把这次的起始日并回去，稍后整段重报。
      pending.set(owner, earlier(pending.get(owner), since));
      const unsupported = error instanceof ProviderGroupRemoteUnsupportedError;
      const count = (failures.get(owner) ?? 0) + 1;
      failures.set(owner, count);
      if (count === 1 || unsupported) {
        deps.log.warn('provider group usage report failed', { ownerDeviceId: owner, unsupported, error: String(error) });
      }
      arm(
        owner,
        unsupported
          ? PROVIDER_GROUP_USAGE_UNSUPPORTED_RETRY_MS
          : Math.min(PROVIDER_GROUP_USAGE_RETRY_MAX_MS, PROVIDER_GROUP_USAGE_RETRY_MIN_MS * 2 ** (count - 1)),
      );
      return;
    } finally {
      inFlight.delete(owner);
    }
    // 送的期间又记了新的用量：接着报。
    if (pending.has(owner)) arm(owner, PROVIDER_GROUP_USAGE_DEBOUNCE_MS);
  }

  // 启动后把每台整份报一次：上次退出前记了、还没送到的也补上。
  for (const owner of deps.owners()) pending.set(owner, 'all');
  for (const owner of pending.keys()) arm(owner, PROVIDER_GROUP_USAGE_STARTUP_DELAY_MS);

  return {
    notify(ownerDeviceId, day) {
      if (disposed || !ownerDeviceId) return;
      pending.set(ownerDeviceId, earlier(pending.get(ownerDeviceId), day));
      // 正在退避等重试的不提前：到点会把这次的也一起报上。
      if ((failures.get(ownerDeviceId) ?? 0) > 0 && timers.has(ownerDeviceId)) return;
      if (!inFlight.has(ownerDeviceId)) arm(ownerDeviceId, PROVIDER_GROUP_USAGE_DEBOUNCE_MS);
    },
    dispose() {
      disposed = true;
      for (const timer of timers.values()) cancel(timer);
      timers.clear();
    },
  };
}
