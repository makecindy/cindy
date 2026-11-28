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

import { createElement, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { toast } from '@/lib/toast';
import { ApiError } from '@/lib/httpClient';
import { forkAtMessage, getForkCapabilities, requestFork } from '@/lib/sessionService';
import { createForkRequestId, type ForkRequest, type ForkTarget, type ForkOutcome } from '@cindy/maker-shared/fork-request';
import { ForkTargetPicker } from './ForkTargetPicker';
import { saveDraft as saveComposerDraft } from '@/lib/composerDraftStore';
import type { JSONContent } from '@tiptap/core';
import { emitRefresh as emitSessionsRefresh } from '@/lib/sessionsBus';
import { getSessionDeviceId } from '@/features/device-link/remoteProjectsStore';
import { refreshRemoteDeviceSessions } from '@/features/device-link/refreshRemoteSessions';
import {
  useSessionNavigationIntent,
  useSessionNavigationMode,
} from '@/features/cc-agent/embeddedSessionNavigation';
import { createLogger } from '@/lib/logger';
import { isCodexResumeNotReadyProjectionError } from '@cindy/maker-shared/agent-input-projection';
import { remoteAgentErrorCode } from '@cindy/device-link';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';

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

export interface ForkAtMessageRunOptions {
  /** 用户在确认框点了「开启新任务」、真正开始创建时调用；取消或被拦下时不调用。 */
  onConfirmed?: () => void;
}

export function useForkAtMessage({
  sessionId,
  messageClientId,
  forkBlocked,
  draftText,
  draftDocument,
}: UseForkAtMessageOptions): (options?: ForkAtMessageRunOptions) => Promise<void> {
  const { t } = useTranslation();
  const { confirm, confirmThree } = useConfirmDialog();
  const navigate = useNavigate();
  const navigationMode = useSessionNavigationMode();
  const reportSessionNavigation = useSessionNavigationIntent();
  const active = useRef(false);
  const generation = useRef(0);
  const request = useRef<ForkRequest | undefined>(undefined);
  const sourceKey = `${sessionId ?? ''}\u0000${messageClientId ?? ''}`;
  const sourceKeyRef = useRef(sourceKey);
  sourceKeyRef.current = sourceKey;
  useEffect(() => {
    generation.current += 1;
    request.current = undefined;
    return () => { generation.current += 1; };
  }, [sessionId, messageClientId]);

  return useCallback(async (options?: ForkAtMessageRunOptions) => {
    if (!sessionId || !messageClientId || active.current) return;
    const captured = generation.current;
    const owner = getDataOwnerGeneration();
    const current = () => generation.current === captured && sourceKeyRef.current === sourceKey && isDataOwnerGenerationCurrent(owner);
    const storageKey = `cindy.fork-request.v1:${JSON.stringify([owner.dataOwnerId, getSessionDeviceId(sessionId), sessionId, messageClientId])}`;
    const remember = (next: ForkRequest) => {
      if (!current()) return;
      localStorage.setItem(storageKey, JSON.stringify(next));
      request.current = next;
    };
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
    if (!current() || active.current) return;
    active.current = true;
    options?.onConfirmed?.();
    try {
      const capabilities = await getForkCapabilities(sessionId);
      if (!current()) return;
      let outcome: ForkOutcome | undefined;
      const chooseTarget = async () => {
        let target: ForkTarget | undefined;
        const accepted = await confirm({
          title: t('chat.forkRecovery.choose'), description: t('chat.forkRecovery.handoffDescription'),
          confirmText: t('chat.forkRecovery.continue'), maxWidth: 460,
          content: createElement(ForkTargetPicker, {
            deviceId: getSessionDeviceId(sessionId) ?? undefined,
            onChange: (selection: ForkTarget) => { target = selection; },
          }),
        });
        if (!accepted || !current()) return false;
        if (!target) { toast.error(t('chat.forkRecovery.selectModel')); return false; }
        remember({ version: 1, action: 'create', requestId: createForkRequestId(), sourceSessionId: sessionId,
          messageClientId, target });
        return true;
      };
      let newSession;
      if (capabilities.forkRequestVersion === 1) {
        const saved = localStorage.getItem(storageKey);
        if (!request.current && saved) {
          if (saved.length > 8192) throw new Error(t('chat.forkRecovery.pendingDescription'));
          const prior = JSON.parse(saved) as ForkRequest;
          if (prior.version !== 1 || prior.sourceSessionId !== sessionId || prior.messageClientId !== messageClientId || !prior.requestId) {
            throw new Error(t('chat.forkRecovery.pendingDescription'));
          }
          request.current = prior;
        }
        if (!request.current) remember({ version: 1, action: 'create', requestId: createForkRequestId(), sourceSessionId: sessionId, messageClientId });
        while (current()) {
          try {
            const receipt = await requestFork(request.current!);
            if (!current()) return;
            if (receipt.state === 'complete' && receipt.session) {
              newSession = receipt.session; outcome = receipt.outcome;
              try {
                if (JSON.parse(localStorage.getItem(storageKey) ?? 'null')?.requestId === request.current?.requestId) localStorage.removeItem(storageKey);
              } catch { /* A committed child stays successful even if local cleanup fails. */ }
              request.current = undefined; break;
            }
            const choice = await confirmThree({ title: t('chat.forkRecovery.pendingTitle'),
              description: t('chat.forkRecovery.pendingDescription'),
              confirmText: t(receipt.state === 'failed' || receipt.state === 'not-sent' ? 'chat.forkRecovery.retry' : 'chat.forkRecovery.check'),
              tertiaryText: capabilities.historyHandoff ? t('chat.forkRecovery.choose') : t('chat.forkRecovery.update'),
              cancelText: t('chat.messageActionBar.forkCancel') });
            if (!current() || choice === 'cancel') return;
            if (choice === 'tertiary') {
              if (!capabilities.historyHandoff || !await chooseTarget()) return;
            } else request.current = { ...request.current!, action: receipt.state === 'failed' || receipt.state === 'not-sent' ? 'create' : 'status' };
          } catch (error) {
            if (!current()) return;
            const targetFailure = Boolean(request.current?.target);
            if (!targetFailure && !remoteAgentErrorCode(error instanceof Error ? error.message : String(error))) throw error;
            const choice = await confirmThree({ title: t(targetFailure ? 'chat.forkRecovery.choose' : 'chat.forkRecovery.unavailableTitle'),
              description: t(targetFailure ? 'settings.ghosts.modelPicker.unavailable' : 'chat.forkRecovery.unavailableDescription'), confirmText: t('chat.forkRecovery.retry'),
              tertiaryText: capabilities.historyHandoff ? t('chat.forkRecovery.choose') : t('chat.forkRecovery.update'),
              cancelText: t('chat.messageActionBar.forkCancel') });
            if (!current() || choice === 'cancel') return;
            if (choice === 'tertiary') {
              if (!capabilities.historyHandoff) { toast.error(t('chat.forkRecovery.update')); return; }
              if (!await chooseTarget()) return;
            } else request.current = { ...request.current!, action: 'create' };
          }
        }
      } else {
        try { newSession = await forkAtMessage(sessionId, messageClientId); }
        catch (error) {
          if (remoteAgentErrorCode(error instanceof Error ? error.message : String(error))) {
            if (current()) toast.error(t('chat.forkRecovery.update'));
            return;
          }
          throw error;
        }
      }
      if (!newSession || !current()) return;
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
      if (!current()) return;
      reportSessionNavigation?.(newSession.id, newSession.id);
      navigate(`/cc-agent/${newSession.id}`);
      if (outcome) toast.success(t(outcome === 'native' ? 'chat.forkRecovery.nativeSuccess' : 'chat.forkRecovery.handoffSuccess'));
    } catch (err) {
      if (!current()) return;
      const code = err instanceof ApiError ? err.code : 'UNKNOWN';
      const detail = err instanceof Error ? err.message : String(err);
      const remoteCode = remoteAgentErrorCode(detail);
      const msg =
        remoteCode
          ? t(`chat.remoteError.${remoteCode}`, { defaultValue: t('chat.userMessage.forkErrors.generic') })
          : code === 'FORK_UNSUPPORTED_HISTORY'
          ? t('chat.userMessage.forkErrors.unsupportedHistory')
          : code === 'NO_PRIOR_ASSISTANT'
            ? t('chat.userMessage.forkErrors.noPriorAssistant')
            : code === 'SOURCE_NEVER_RAN'
              ? t('chat.userMessage.forkErrors.sourceNeverRan')
              : code === 'CODEX_FORK_STATE_UNAVAILABLE'
                ? isCodexResumeNotReadyProjectionError(detail)
                  ? t('chat.errorBanner.codexResumeNotReady')
                  : t('chat.userMessage.forkErrors.codexStateUnavailable', { detail })
                : t('chat.userMessage.forkErrors.generic');
      toast.error(msg);
      // Re-throw so MessageActionBar's `forking` state knows to clear via
      // its finally{} (it doesn't actually re-throw further — just resets).
      throw err;
    } finally {
      active.current = false;
    }
  }, [
    sessionId,
    messageClientId,
    navigationMode,
    reportSessionNavigation,
    forkBlocked,
    draftText,
    draftDocument,
    confirm,
    confirmThree,
    navigate,
    t,
  ]);
}
