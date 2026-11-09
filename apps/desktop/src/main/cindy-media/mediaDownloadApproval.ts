import { randomUUID } from 'node:crypto';
import type { InteractionRequest, Session } from '@cindy/maker-core';
import { t } from '../i18n.js';
import { requestHostInteraction } from '../maker-ipc/interactionRouter.js';
import {
  MediaDownloadError,
  type MediaDownloadContext,
  type MediaDownloadReason,
} from './mediaDownload.js';

/** Exceptions that stay on the confirmation card even under full access. */
const FULL_ACCESS_CONFIRMATION_REASONS = new Set<MediaDownloadReason>([
  'http', 'port', 'credentials', 'network',
]);

/** Bind approval to the live Host turn, never to a model-supplied approval flag. */
export function createMediaDownloadContext(
  session: Session,
  isCurrent: () => boolean,
): MediaDownloadContext {
  const generation = session.getTurnGeneration();
  const controller = new AbortController();
  const isActive = () => isCurrent() && session.getTurnGeneration() === generation &&
    session.getStatus() === 'active' && session.isTurnRunning();
  const assertActive = () => {
    if (!isActive() || controller.signal.aborted) {
      throw new MediaDownloadError('MEDIA_DOWNLOAD_DEFERRED', '本次下载已停止，原生成结果已保留');
    }
  };
  const unsubscribe = session.onStatusChange(() => {
    if (!isActive()) controller.abort();
  });
  return {
    approvals: new Set<string>(),
    signal: controller.signal,
    dispose: unsubscribe,
    assertActive,
    confirm: async ({ source, reasons }) => {
      assertActive();
      // Full access covers an ordinary download (an unknown HTTPS source).
      // HTTP, a non-default port, URL credentials, and a private-network target
      // still need the confirmation card. A null stable mode is in-flight and
      // stays fail-closed.
      const ordinaryDownload = reasons.every((reason) => !FULL_ACCESS_CONFIRMATION_REASONS.has(reason));
      if (session.stablePermissionModeState?.mode === 'bypassPermissions' && ordinaryDownload) return true;
      // Bound only the human decision; generation has its own request timeout.
      const approvalSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(8 * 60_000)]);
      const details = reasons.map((reason) => t(`newChat.mediaDownload.${reason}`)).join('\n');
      const request: InteractionRequest = {
        kind: 'permission',
        requestId: randomUUID(),
        toolName: 'cindy.media.download',
        title: t('newChat.mediaDownload.title'),
        description: `${t('newChat.mediaDownload.description')}\n${details}\n${t('newChat.mediaDownload.scope')}`,
        input: { source },
        metadata: { hostOwnedConfirmation: 'media_download' },
      };
      const decision = await session.runHostInteraction(request, () =>
        requestHostInteraction(session, request, approvalSignal));
      assertActive();
      // No permissionUpdates or updatedInput is consumed. Only this request can be approved.
      return decision.kind === 'permission' && decision.behavior === 'allow';
    },
  };
}
