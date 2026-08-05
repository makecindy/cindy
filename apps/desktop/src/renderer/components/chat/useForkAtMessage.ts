/**
 * useForkAtMessage — fork-from-message 共享动作 hook。
 * ---------------------------------------------------------------------------
 * UserMessage（在提问上分叉：复制提问之前的内容，并把提问文本预填进新会话
 * composer）与 AssistantMessage（在 AI 回复上分叉：复制含该回复所在 turn 的
 * 全部内容，无预填）共用同一套流程：
 *   forkBlocked 拦截 toast → 功能介绍确认框 → maker:fork IPC → 可选 composer 预填 →
 *   sidebar refresh → navigate → 错误码映射 toast。
 *
 * 语义差异（复制边界）由 main 侧 forkSessionAtMessage 按 target role 决定，
 * renderer 只负责传 clientId；draftText 由调用方按各自语义传入。
 */

import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { toast } from '@/lib/toast';
import { ApiError } from '@/lib/httpClient';
import { forkAtMessage } from '@/lib/sessionService';
import { saveDraft as saveComposerDraft } from '@/lib/composerDraftStore';
import type { JSONContent } from '@tiptap/core';
import { emitRefresh as emitSessionsRefresh } from '@/lib/sessionsBus';
import { getSessionDeviceId } from '@/features/device-link/remoteProjectsStore';
import { refreshRemoteDeviceSessions } from '@/features/device-link/refreshRemoteSessions';
import { useSessionNavigationMode } from '@/features/cc-agent/embeddedSessionNavigation';
import { createLogger } from '@/lib/logger';

const log = createLogger('useForkAtMessage');

/** Wrap a plain text string into a minimal Tiptap doc — enough for the
 *  ChatInput composer to hydrate from on mount. Empty/whitespace-only text
 *  collapses to `null` so the composer stays empty. */
export function textToTiptapDoc(text: string) {
  const trimmed = text ?? '';
  if (!trimmed) return null;
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: trimmed }],
      },
    ],
  };
}

interface UseForkAtMessageOptions {
  /** Owning session id; fork 入口未接线（缺 id）时 handler 直接 no-op。 */
  sessionId?: string;
  /** fork 点消息的 clientId（messages.client_id）。 */
  messageClientId?: string;
  /** 目标消息自身仍未稳定时只 toast 拦截。session running 不再全局阻塞 fork,
   *  这样可以从已完成的历史消息分叉去问 by-the-way 问题。 */
  forkBlocked?: boolean;
  /** fork 成功后预填到新会话 composer 的纯文本（user 消息分叉用——
   *  "改写提问"流；assistant 消息分叉不传 = 不预填）。 */
  draftText?: string;
  /** 已按正文顺序建好的 Tiptap 文档。inline quote 消息用它保留交错顺序。 */
  draftDocument?: JSONContent | null;
}

export function useForkAtMessage({
  sessionId,
  messageClientId,
  forkBlocked,
  draftText,
  draftDocument,
}: UseForkAtMessageOptions): () => Promise<void> {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const navigate = useNavigate();
  const navigationMode = useSessionNavigationMode();

  return useCallback(async () => {
    if (!sessionId || !messageClientId) return;
    if (navigationMode === 'sidebar-embedded') {
      log.info('message fork ignored by embedded sidebar view', { sessionId, messageClientId });
      return;
    }
    if (forkBlocked) {
      toast.error(t('chat.userMessage.forkBusy'));
      return;
    }
    const confirmed = await confirm({
      title: t('chat.messageActionBar.forkConfirmTitle'),
      description: t('chat.messageActionBar.forkConfirmDescription'),
      confirmText: t('chat.messageActionBar.forkConfirm'),
      cancelText: t('chat.messageActionBar.forkCancel'),
      autoFocusConfirm: true,
    });
    if (!confirmed) return;
    try {
      const newSession = await forkAtMessage(sessionId, messageClientId);
      // Pre-fill the new session's composer so the user lands on a
      // ready-to-edit prompt. saveDraft MUST happen before navigate,
      // otherwise ChatInput's mount effect reads `undefined` first and the
      // composer flashes empty for one frame.
      // (image/file attachments intentionally skipped — fork-and-edit is
      // typically a "rephrase the question" flow; carry them forward later
      // if real usage shows we need it.)
      const draftDoc =
        draftDocument === undefined ? textToTiptapDoc(draftText ?? '') : draftDocument;
      if (draftDoc) {
        saveComposerDraft(newSession.id, {
          text: draftDoc,
          attachments: [],
        });
      }
      // Tell sidebar instances to refetch so the new session appears in the
      // current time group (user_send_at = now is set by backend).
      emitSessionsRefresh();
      // device-link 远程会话:fork 出的新 session 在被控端,需先把该设备会话列表重拉进
      // remoteProjectsStore 注册新 sessionId,否则 navigate 会把它当本地会话 404(等轮询太慢)。
      const deviceId = getSessionDeviceId(sessionId);
      if (deviceId) await refreshRemoteDeviceSessions(deviceId);
      navigate(`/cc-agent/${newSession.id}`);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'UNKNOWN';
      const msg =
        code === 'FORK_UNSUPPORTED_HISTORY'
          ? t('chat.userMessage.forkErrors.unsupportedHistory')
          : code === 'NO_PRIOR_ASSISTANT'
            ? t('chat.userMessage.forkErrors.noPriorAssistant')
            : code === 'SOURCE_NEVER_RAN'
              ? t('chat.userMessage.forkErrors.sourceNeverRan')
              : code === 'CODEX_FORK_STATE_UNAVAILABLE'
                ? t('chat.userMessage.forkErrors.codexStateUnavailable', {
                    detail: err instanceof Error ? err.message : String(err),
                  })
                : t('chat.userMessage.forkErrors.generic');
      toast.error(msg);
      // Re-throw so MessageActionBar's `forking` state knows to clear via
      // its finally{} (it doesn't actually re-throw further — just resets).
      throw err;
    }
  }, [
    sessionId,
    messageClientId,
    navigationMode,
    forkBlocked,
    draftText,
    draftDocument,
    confirm,
    navigate,
    t,
  ]);
}
