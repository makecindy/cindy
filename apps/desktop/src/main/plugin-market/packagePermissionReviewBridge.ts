/**
 * 市场真实包权限确认的 Main ↔ Renderer 往返桥。
 *
 * 它只保存“当前窗口对当前弹框的回答”，不保存包路径、安装状态或批准记录。
 * 安装事务本身仍停在 service.install() 的调用栈里；确认、取消或窗口销毁后，
 * promise 立即结算，service 的 finally 负责删除临时包。
 */

import { randomUUID } from 'node:crypto';

import type {
  PluginMarketPackageReviewFacts,
  PluginMarketPackageReviewRequest,
} from '../../shared/pluginMarket.js';
import type { DataOwnerPushStamp } from '../../shared/dataOwnerPush.js';

interface PendingReview {
  requesterId: number;
  resolve: (confirmed: boolean) => void;
}

export class PluginMarketPackagePermissionReviewBridge {
  private readonly pending = new Map<string, PendingReview>();

  request(
    requesterId: number,
    facts: PluginMarketPackageReviewFacts,
    ownerStamp: DataOwnerPushStamp,
    send: (request: PluginMarketPackageReviewRequest) => boolean,
  ): Promise<boolean> {
    const requestId = randomUUID();
    return new Promise<boolean>((resolve) => {
      this.pending.set(requestId, { requesterId, resolve });
      let delivered = false;
      try {
        delivered = send({
          requestId,
          ownerStamp,
          manifest: facts.manifest,
          permissionDiff: facts.permissionDiff,
          isUpdate: facts.isUpdate,
          sourceType: facts.sourceType,
          builtinOauthClientChanged: facts.builtinOauthClientChanged,
        });
      } finally {
        if (!delivered) this.settle(requestId, false);
      }
    });
  }

  resolve(requesterId: number, requestId: string, confirmed: unknown): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.requesterId !== requesterId) return false;
    this.settle(requestId, confirmed === true);
    return true;
  }

  cancelRequester(requesterId: number): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.requesterId === requesterId) this.settle(requestId, false);
    }
  }

  private settle(requestId: string, confirmed: boolean): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    pending.resolve(confirmed);
  }
}
