/**
 * session-title-rename/index.ts —— rename_sessions 确认桥 holder。
 */

import type {
  RenameSessionsConfirmBridge,
  RenameSessionsConfirmItem,
} from './renameSessionsConfirmBridge';

export { RenameSessionsConfirmBridge } from './renameSessionsConfirmBridge';
export type {
  RenameSessionsConfirmDecision,
  RenameSessionsConfirmInteractionSnapshot,
} from './renameSessionsConfirmBridge';

let bridgeHolder: RenameSessionsConfirmBridge | null = null;

export function initRenameSessionsConfirm(bridge: RenameSessionsConfirmBridge): void {
  bridgeHolder = bridge;
}

export async function confirmRenameSessionsForSession(req: {
  sessionId: string;
  changes: RenameSessionsConfirmItem[];
}): Promise<
  | { ok: true }
  | {
      ok: false;
      errorCode: 'USER_CANCELLED' | 'CONFIRM_TIMEOUT' | 'HOST_NOT_READY';
      message: string;
    }
> {
  const bridge = bridgeHolder;
  if (!bridge) {
    return {
      ok: false,
      errorCode: 'HOST_NOT_READY',
      message: 'Cindy 主进程批量改名确认服务尚未就绪,请告知用户稍等几秒后重试。',
    };
  }

  const decision = await bridge.request(req.sessionId, req.changes);
  if (decision.confirmed) return { ok: true };
  if (decision.reason === 'timeout') {
    return {
      ok: false,
      errorCode: 'CONFIRM_TIMEOUT',
      message: '确认卡片超时未响应,本次未改名。告知用户可以重新发起。',
    };
  }
  return {
    ok: false,
    errorCode: 'USER_CANCELLED',
    message: '用户取消了本次批量改名。如实告知即可,不要自动重试。',
  };
}
