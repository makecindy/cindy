import { DeviceLinkError, type PushOwnerStamp } from '@cindy/device-link';

/**
 * 账号级状态镜像推送的出站整流(latest-wins,按 channel + 键暂存)。
 *
 * 这些推送都是「整帧替换」的状态快照:控制端收到后直接用新快照覆盖旧值
 * (renderer remoteDeviceUsageMirror「push 整帧替换」、调度运行诊断只换快照)。
 * 同一个键只有**最新值**有意义,而它们的产生频率与链路无关——零点多条自动化
 * 同时认领时 `maker:schedule:event` 的 runtime-state 一次几十帧、每帧约 1 KB;
 * 用量快照每个 turn / 刷新节流点各一帧。直接写进 per-peer 可靠窗口(64 帧)时,
 * 对端一卡就占满窗口,把控制端真正在等的 invoke-result 挤成
 * `reliable transport buffer is full`(2026-11-10~14 日志:iPhone 345 次,
 * 队列 top 依次为 schedule:event、codex-provider-account-changed)。
 *
 * 与传输层 COALESCIBLE_PUSH_CHANNELS 的区别(那里只能驱逐队头、无法同键比较):
 * 这里在**进入**可靠窗口之前暂存,同键新值替换旧值,窗口占用超过软上限时
 * 停止灌入并退避重试。终态不丢:每个键始终保留最新值,直到真正写进链路或
 * 控制端退订 / 离线(那时控制端重连会重新 warm-start 读取),因此不会出现
 * 「最后一帧被别的键挤掉、控制端永久停在旧状态」。
 */

/**
 * 可整流的状态镜像通道与键。只收「整帧替换、无副作用、可由控制端重读自愈」的
 * 快照;事件流(fired / completed / read 等驱动刷新与未读的调度事件)、增量补丁
 * 与通知类推送一律不进,返回 null 走原逐帧路径。新增条目要论证上述三点。
 */
export function latestStatePushKey(channel: string, payload: unknown): string | null {
  switch (channel) {
    case 'maker:schedule:event': {
      // 只整流运行诊断快照:完整 snapshot、高频,远程控制端(手机 / 桌面远程项目)
      // 的事件投影把它判为「不刷新、不改 run」。其余调度事件保持逐帧与顺序。
      const type = isRecord(payload) ? payload.type : undefined;
      return type === 'runtime-state' ? `${channel}#runtime-state` : null;
    }
    case 'usage:claude-subscription-changed':
    case 'usage:codex-account-changed':
    case 'usage:claude-account-changed':
    case 'usage:xai-subscription-changed':
    case 'usage:xai-rate-limit-changed':
      return channel;
    case 'usage:codex-provider-account-changed':
    case 'usage:subscription-provider-account-changed':
    case 'usage:xai-provider-rate-limit-changed': {
      // { providerId, snapshot }:按账号分路,不同账号互不替换。
      const providerId = isRecord(payload) ? payload.providerId : undefined;
      return typeof providerId === 'string' && providerId ? `${channel}#${providerId}` : null;
    }
    default:
      return null;
  }
}

export interface LatestStatePush {
  channel: string;
  payload: unknown;
}

/** 首次暂存后的合并窗口;与会话补丁暂存同档,对快照类 UI 不可感知。 */
export const LATEST_STATE_PUSH_DELAY_MS = 250;
/** 单轮最多写入的帧数,避免刚恢复的窗口被一次填满。 */
const LATEST_STATE_PUSH_DRAIN_BATCH = 8;
const RETRY_CODES = new Set(['BACKPRESSURE', 'NOT_CONNECTED', 'LINK_NOT_OPEN']);

export class LatestStatePushStage {
  private readonly pending = new Map<string, LatestStatePush>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private draining = false;
  private disposed = false;

  constructor(
    readonly ownerStamp: PushOwnerStamp | undefined,
    /** 是否可以向该对端写入(链路可用且窗口在软上限内);false 时整体退避。 */
    private readonly writable: () => boolean,
    /** 写入一帧;isCurrent() 为 false 表示授权等待期间已被同键新值替换或已释放。 */
    private readonly send: (item: LatestStatePush, isCurrent: () => boolean) => Promise<void>,
    private readonly failed: (item: LatestStatePush, error: unknown) => void,
  ) {}

  enqueue(key: string, item: LatestStatePush): void {
    if (this.disposed) return;
    // 重新插入到末尾:按最近更新排序,长期不变的键不会抢在新鲜键前面。
    this.pending.delete(key);
    this.pending.set(key, item);
    this.schedule();
  }

  get size(): number {
    return this.pending.size;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }

  private schedule(): void {
    if (this.disposed || this.timer || this.draining || this.pending.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, LATEST_STATE_PUSH_DELAY_MS);
  }

  private async drain(): Promise<void> {
    if (this.disposed || this.draining) return;
    this.draining = true;
    try {
      for (let count = 0; count < LATEST_STATE_PUSH_DRAIN_BATCH && this.pending.size > 0; count++) {
        if (this.disposed || !this.writable()) break;
        const [key, item] = this.pending.entries().next().value!;
        const isCurrent = () => !this.disposed && this.pending.get(key) === item;
        try {
          await this.send(item, isCurrent);
        } catch (error) {
          // 窗口满 / 链路暂不可写:保留最新值,稍后重试。
          if (error instanceof DeviceLinkError && RETRY_CODES.has(error.code)) break;
          this.failed(item, error);
        }
        if (isCurrent()) this.pending.delete(key);
      }
    } finally {
      this.draining = false;
      this.schedule();
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
