/**
 * 用户在插件页、拖入或双击 `.cindy` 发起安装时的窗口级确认往返。
 *
 * 确认只投给发起安装的那个窗口（按 webContents id 绑定），也只接受那个窗口的回答；
 * 窗口销毁、导航、账号边界或超时都按取消结算，并通知窗口收起还开着的确认框。
 * Agent 发起的安装不走这里，走任务里的宿主权限确认卡（可在手机上确认）。
 *
 * 本模块不依赖 Electron，发送函数由 index.ts 注入，便于单测。
 */
import { randomUUID } from 'node:crypto';

import type { GhostInstallConsentRequest } from '../../shared/ghostInstallConsent.js';
import { HOST_CONFIRM_TIMEOUT_MS } from '../maker-ipc/hostConfirmTiming.js';

export interface GhostInstallConsentWindowTarget {
  /** webContents id；回答必须来自同一个 id。 */
  id: number;
  /** 投递确认请求；返回 false 表示窗口不可用。 */
  send(request: GhostInstallConsentRequest): boolean;
  /** 通知窗口收起指定确认框（已结算）。 */
  dismiss(requestId: string): void;
}

interface PendingConsent {
  target: GhostInstallConsentWindowTarget;
  resolve: (confirmed: boolean) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export class GhostInstallConsentWindowBridge {
  private readonly pending = new Map<string, PendingConsent>();

  constructor(private readonly deps: { timeoutMs?: number } = {}) {}

  request(
    target: GhostInstallConsentWindowTarget,
    request: Omit<GhostInstallConsentRequest, 'requestId'>,
  ): Promise<boolean> {
    const requestId = randomUUID();
    return new Promise<boolean>((resolve, reject) => {
      const timeoutId = setTimeout(
        () => this.settle(requestId, false),
        this.deps.timeoutMs ?? HOST_CONFIRM_TIMEOUT_MS,
      );
      this.pending.set(requestId, { target, resolve, timeoutId });
      let delivered = false;
      try {
        delivered = target.send({ ...request, requestId });
      } catch {
        delivered = false;
      }
      if (!delivered) {
        this.pending.delete(requestId);
        clearTimeout(timeoutId);
        reject(new Error('没有可显示安装确认的窗口'));
      }
    });
  }

  /** 返回是否命中本桥的待确认请求。只接受发起窗口的回答。 */
  resolve(requesterId: number, requestId: string, confirmed: unknown): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.target.id !== requesterId) return false;
    this.settle(requestId, confirmed === true);
    return true;
  }

  cancelRequester(requesterId: number): void {
    for (const [requestId, pending] of Array.from(this.pending.entries())) {
      if (pending.target.id === requesterId) this.settle(requestId, false);
    }
  }

  cancelAll(): void {
    for (const requestId of Array.from(this.pending.keys())) this.settle(requestId, false);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private settle(requestId: string, confirmed: boolean): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timeoutId);
    try {
      pending.target.dismiss(requestId);
    } catch {
      // 窗口已销毁时无需再收起确认框。
    }
    pending.resolve(confirmed);
  }
}
