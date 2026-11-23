/**
 * useDeleteMessage — 消息菜单的本地删除动作。
 *
 * 这里不复用 rewind：rewind 会裁掉 target 及其后的所有轮次并回滚文件；本功能让
 * user 只清目标行、assistant 清所属真实用户轮的全部输出，保留其它轮次，并让 main
 * 在下一次发送前以剩余本地历史重建原生 Agent 上下文。
 */

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { getSessionDeviceId } from '@/features/device-link/remoteProjectsStore';
import { refreshRemoteDeviceSessions } from '@/features/device-link/refreshRemoteSessions';
import { createLogger } from '@/lib/logger';
import { makerChatStore } from '@/lib/makerChatStore';
import { deleteMessageFor } from '@/lib/makerTransport';
import { emitRefresh as emitSessionsRefresh } from '@/lib/sessionsBus';
import { toast } from '@/lib/toast';

const log = createLogger('useDeleteMessage');

interface UseDeleteMessageOptions {
  sessionId?: string;
  messageClientId?: string;
  /** 运行中的 turn 不允许删气泡，避免正在落库的增量把它立刻补回来。 */
  blocked?: boolean;
}

export function useDeleteMessage({
  sessionId,
  messageClientId,
  blocked = false,
}: UseDeleteMessageOptions): () => Promise<void> {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();

  return useCallback(async () => {
    if (!sessionId || !messageClientId) return;
    if (blocked) {
      toast.warning(t('chat.messageActionBar.deleteBusy'));
      return;
    }

    const ok = await confirm({
      title: t('chat.messageActionBar.deleteConfirmTitle'),
      description: t('chat.messageActionBar.deleteConfirmDescription'),
      confirmText: t('chat.messageActionBar.deleteConfirm'),
      cancelText: t('chat.messageActionBar.deleteCancel'),
      confirmVariant: 'destructive',
    });
    if (!ok) return;

    try {
      const result = await deleteMessageFor(sessionId, messageClientId);
      const returnedClientIds = Array.isArray(result.clientIds)
        ? result.clientIds.filter((clientId): clientId is string =>
            typeof clientId === 'string' && clientId.length > 0,
          )
        : [];
      // main 广播通常会先一步移除；这里再做一次幂等镜像，覆盖旧 preload / 老
      // 被控端没有 push 通道但 invoke 已成功的兼容窗口。老 host 不返回
      // clientIds 时至少清掉用户实际点击的目标行。
      makerChatStore.removeMessagesByClientIds(
        sessionId,
        returnedClientIds.length > 0 ? returnedClientIds : [messageClientId],
      );
      emitSessionsRefresh();
      const deviceId = getSessionDeviceId(sessionId);
      if (deviceId) void refreshRemoteDeviceSessions(deviceId);
    } catch (err) {
      log.warn('message delete failed', {
        sessionId,
        messageClientId,
        error: err instanceof Error ? err.message : String(err),
      });
      toast.error(t('chat.messageActionBar.deleteFailed'));
    }
  }, [blocked, confirm, messageClientId, sessionId, t]);
}
