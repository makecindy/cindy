/**
 * GhostConfirmDialogBridge —— confirm 槽的 main ↔ renderer 往返桥(2026-07-31)。
 *
 * confirm 槽要的是**答案**,而 notify 那条通道是单向的(broadcast 完就结束)。
 * 所以这里照 GhostGrantConfirmBridge 的成熟模式做一条带回执的往返:
 * main 铸一个 requestId → 投给 renderer → pending promise 挂起 → renderer 用
 * ConfirmDialogProvider 弹主机同款确认框 → 用户点击后经 IPC 回包 → settle。
 *
 * 与过户确认卡(GhostGrantConfirmBridge)的两处不同,都是刻意的:
 *
 * 1. **只投一个窗口,不 broadcast**。过户确认卡是聊天流里的卡片,广播到多窗口
 *    再靠 DISMISSED 收卡没问题;模态确认框广播出去会在每个窗口各弹一个、收回
 *    多份答案(preview 槽注释里踩过同类坑)。所以这里由 deps.sendToWindow 精确
 *    投递单个窗口(focused ?? 第一个),投不出去就 reject 让槽回 UNAVAILABLE。
 * 2. **不挂会话**。它可能来自面板点击、也可能来自工具调用链,不一定有 sessionId;
 *    清理靠超时与显式 cancelAll(窗口关闭/插件沉睡时调)。
 *
 * fail closed 是本模块的第一原则:超时、投递失败、回包形状非法、被清理,
 * 一律 resolve 成 false(没同意)。绝不把「问不出来」错当成「用户同意了」。
 *
 * 本模块保持 electron-free(投递由 index.ts 注入),单测直接 new。
 */

import { randomUUID } from 'node:crypto';

import { GHOST_CONFIRM_TIMEOUT_MS } from '../../shared/ghost.js';

/** 推给 renderer 的确认框载荷(身份三件套由主机填,renderer 只负责画)。 */
export interface GhostConfirmPush {
  requestId: string;
  ghostId: string;
  ghostName: string;
  iconDataUrl?: string;
  body: string;
  /** null = renderer 用自己的缺省按钮文案(跟用户语言走)。 */
  confirmText: string | null;
  cancelText: string | null;
  danger: boolean;
}

export interface GhostConfirmDialogBridgeDeps {
  /**
   * 把确认框投给**一个**窗口。返回 false = 没有可投的窗口(桥据此 reject,
   * 槽回 UNAVAILABLE,而不是谎报用户拒绝)。
   */
  sendToWindow(payload: GhostConfirmPush): boolean;
  /** 兜底超时;缺省 GHOST_CONFIRM_TIMEOUT_MS。测试注小值。 */
  timeoutMs?: number;
  now?(): number;
  log?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

interface PendingConfirmEntry {
  ghostId: string;
  resolve: (confirmed: boolean) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export class GhostConfirmDialogBridge {
  private readonly pending = new Map<string, PendingConfirmEntry>();

  constructor(private readonly deps: GhostConfirmDialogBridgeDeps) {}

  /**
   * 弹一个确认框并等答案。没有可投窗口时 reject(区别于「用户拒绝」)。
   * 其余一切异常路径都 resolve(false)。
   */
  request(params: Omit<GhostConfirmPush, 'requestId'>): Promise<boolean> {
    const requestId = randomUUID();
    return new Promise<boolean>((resolve, reject) => {
      const delivered = this.deps.sendToWindow({ requestId, ...params });
      if (!delivered) {
        reject(new Error('没有可挂靠的宿主窗口'));
        return;
      }
      const timeoutMs = this.deps.timeoutMs ?? GHOST_CONFIRM_TIMEOUT_MS;
      const timeoutId = setTimeout(() => {
        // 没人应答 = 没同意。日志留痕,方便排查"插件说它问了但我没看到"。
        this.deps.log?.warn('ghost confirm timed out (treated as declined)', {
          ghostId: params.ghostId,
          requestId,
        });
        this.settle(requestId, false);
      }, timeoutMs);
      this.pending.set(requestId, { ghostId: params.ghostId, resolve, timeoutId });
    });
  }

  /**
   * renderer 回包。返回是否命中本桥的 pending(false = 陌生/已结算的 requestId,
   * 直接忽略——重复回包与伪造 id 都走这条,不抛)。
   * 非布尔的 confirmed 一律按 false 兜底,不让沙箱靠畸形回包骗到「同意」。
   */
  resolve(requestId: string, confirmed: unknown): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    if (typeof confirmed !== 'boolean') {
      this.deps.log?.warn('ghost confirm: invalid decision shape, treated as declined', {
        requestId,
      });
    }
    this.settle(requestId, confirmed === true);
    return true;
  }

  /**
   * 清掉在途确认(窗口全关、插件沉睡/卸载时调):一律按「没同意」结算,
   * 免得插件那侧永久挂起。传 ghostId 只清该插件的。
   */
  cancelAll(ghostId?: string): void {
    for (const [requestId, entry] of Array.from(this.pending.entries())) {
      if (ghostId !== undefined && entry.ghostId !== ghostId) continue;
      this.settle(requestId, false);
    }
  }

  /** 在途单数(单测与诊断用)。 */
  get pendingCount(): number {
    return this.pending.size;
  }

  private settle(requestId: string, confirmed: boolean): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    clearTimeout(entry.timeoutId);
    entry.resolve(confirmed);
  }
}

let bridgeSingleton: GhostConfirmDialogBridge | null = null;

/**
 * 初始化单例(cindy-brain/index.ts 装配期调用,注入投递)。未初始化(极早期/
 * 单测环境)时 getter 返回 null,调用方按「确认通道未就绪」拒绝,不抛。
 */
export function initGhostConfirmDialogBridge(
  deps: GhostConfirmDialogBridgeDeps,
): GhostConfirmDialogBridge {
  bridgeSingleton = new GhostConfirmDialogBridge(deps);
  return bridgeSingleton;
}

export function getGhostConfirmDialogBridge(): GhostConfirmDialogBridge | null {
  return bridgeSingleton;
}
