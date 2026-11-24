/**
 * GhostFormDialogBridge —— form 槽的 main ↔ renderer 往返桥(2026-11-23)。
 *
 * 照确认弹窗桥(GhostConfirmDialogBridge)的模式:main 铸 requestId → 投给**一个**窗口 →
 * pending 挂起 → renderer 弹主机画的表单 → 用户保存/取消后经 IPC 回包 → settle。
 *
 * 与确认弹窗桥的不同,都因为表单要填一阵子:
 * 1. 超时长(GHOST_FORM_TIMEOUT_MS),到点按取消结算并**收起**那个窗口里的表单,
 *    免得用户填完点保存却已经没人在等;
 * 2. 记住投给了哪个窗口:只认那个窗口的回包;窗口关闭或渲染进程崩溃时立刻按取消结算,
 *    不让插件干等十分钟。
 *
 * fail closed:超时、回包形状非法、被清理,一律结算成 cancel。
 * 本模块保持 electron-free(投递由 index.ts 注入),单测直接 new。
 */

import { randomUUID } from 'node:crypto';

import { GHOST_FORM_TIMEOUT_MS, type GhostFormAnswer, type GhostFormSpec } from '../../shared/ghostForm.js';

/** 推给 renderer 的表单载荷(身份由主机填,renderer 只负责画)。 */
export interface GhostFormPush {
  requestId: string;
  ghostId: string;
  ghostName: string;
  iconDataUrl?: string;
  spec: GhostFormSpec;
}

/** 投递目标:哪个窗口在弹、怎么收起、何时关闭。 */
export interface GhostFormDelivery {
  windowId: number;
  dismiss(requestId: string): void;
  /** 窗口关闭/渲染进程没了时回调;返回取消监听的函数。 */
  onClosed(callback: () => void): () => void;
}

export interface GhostFormDialogBridgeDeps {
  /** 把表单投给获得焦点的那个窗口;投不出去返回 null(桥据此 reject,槽回 UNAVAILABLE)。 */
  deliver(payload: GhostFormPush): GhostFormDelivery | null;
  /** 兜底超时;缺省 GHOST_FORM_TIMEOUT_MS。测试注小值。 */
  timeoutMs?: number;
  log?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

interface PendingFormEntry {
  ghostId: string;
  delivery: GhostFormDelivery;
  resolve: (answer: GhostFormAnswer) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  stopWatching: () => void;
}

const CANCEL: GhostFormAnswer = { outcome: 'cancel' };

/** renderer 回包的形状收口;values 的内容由槽按原表单再收一遍。 */
function readAnswer(raw: unknown): GhostFormAnswer | null {
  if (!raw || typeof raw !== 'object') return null;
  const outcome = (raw as { outcome?: unknown }).outcome;
  if (outcome === 'submit') return { outcome: 'submit', values: (raw as { values?: unknown }).values };
  if (outcome === 'cancel') return CANCEL;
  if (outcome === 'action') return { outcome: 'action' };
  return null;
}

export class GhostFormDialogBridge {
  private readonly pending = new Map<string, PendingFormEntry>();

  constructor(private readonly deps: GhostFormDialogBridgeDeps) {}

  /** 弹一个表单并等答复。没有可投窗口时 reject(区别于「用户取消」)。 */
  request(params: Omit<GhostFormPush, 'requestId'>): Promise<GhostFormAnswer> {
    const requestId = randomUUID();
    return new Promise<GhostFormAnswer>((resolve, reject) => {
      const delivery = this.deps.deliver({ requestId, ...params });
      if (!delivery) {
        reject(new Error('没有可挂靠的宿主窗口'));
        return;
      }
      const timeoutId = setTimeout(() => {
        this.deps.log?.warn('ghost form timed out (treated as cancelled)', { ghostId: params.ghostId, requestId });
        this.settle(requestId, CANCEL, true);
      }, this.deps.timeoutMs ?? GHOST_FORM_TIMEOUT_MS);
      const stopWatching = delivery.onClosed(() => this.settle(requestId, CANCEL, false));
      this.pending.set(requestId, { ghostId: params.ghostId, delivery, resolve, timeoutId, stopWatching });
    });
  }

  /**
   * renderer 回包。只认投递目标那个窗口(senderId 不符按陌生 id 处理);返回是否命中。
   * 形状非法的回包按取消结算,不给靠畸形回包混过去的路。
   */
  resolve(senderId: number, requestId: string, raw: unknown): boolean {
    const entry = this.pending.get(requestId);
    if (!entry || entry.delivery.windowId !== senderId) return false;
    const answer = readAnswer(raw);
    if (!answer) this.deps.log?.warn('ghost form: invalid answer shape, treated as cancelled', { requestId });
    this.settle(requestId, answer ?? CANCEL, false);
    return true;
  }

  /** 清掉在途表单(切账号、插件停用时调):按取消结算并收起弹窗。传 ghostId 只清该插件的。 */
  cancelAll(ghostId?: string): void {
    for (const [requestId, entry] of Array.from(this.pending.entries())) {
      if (ghostId !== undefined && entry.ghostId !== ghostId) continue;
      this.settle(requestId, CANCEL, true);
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private settle(requestId: string, answer: GhostFormAnswer, dismiss: boolean): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    clearTimeout(entry.timeoutId);
    entry.stopWatching();
    if (dismiss) {
      try { entry.delivery.dismiss(requestId); } catch { /* 窗口正在关:没有可收起的了 */ }
    }
    entry.resolve(answer);
  }
}

let bridgeSingleton: GhostFormDialogBridge | null = null;

export function initGhostFormDialogBridge(deps: GhostFormDialogBridgeDeps): GhostFormDialogBridge {
  bridgeSingleton = new GhostFormDialogBridge(deps);
  return bridgeSingleton;
}

export function getGhostFormDialogBridge(): GhostFormDialogBridge | null {
  return bridgeSingleton;
}
