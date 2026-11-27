import { useSyncExternalStore } from 'react';
import { CornerDownRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { parseSourceSessionTarget } from '@cindy/maker-shared/message-source';

import { useSessionLinkTarget } from '@/components/chat/SessionLinkChip';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { Tip } from '@/components/ui/tooltip';
import { useSessionDelegatingBot } from '@/features/bots/botFollowScopes';
import {
  remoteProjectsStore,
  useRemoteSessionTitle,
} from '@/features/device-link/remoteProjectsStore';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import type { Session } from '@/lib/ccAgent.types';
import { buildSessionDeepLink } from '@/lib/deepLink';
import { sessionsStore } from '@/lib/sessionsStore';
import { toast } from '@/lib/toast';
import { isInteractiveSessionNavigationMode, useSessionNavigationMode } from './embeddedSessionNavigation';

function useLiveOriginTitle(sessionId: string | undefined, remote: boolean): string | null {
  const localTitle = useSyncExternalStore(
    (onChange) => sessionsStore.subscribe(onChange),
    () => (sessionId && !remote ? sessionsStore.getTitleById(sessionId) : null),
  );
  const remoteTitle = useRemoteSessionTitle(remote ? sessionId : undefined);
  return remote ? remoteTitle : localTitle;
}

/**
 * 由其他任务经 `send_to_session`（create 模式）打开的普通任务，在任务头部展示安静的来源标记，
 * 点击可跳转回来源任务。与 `BotTaskOwnerChip` 互斥（伙伴打开的任务已由伙伴 chip 说明）。
 */
export function SessionOriginChip({ session }: { session: Session }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const navigationMode = useSessionNavigationMode();
  const delegatingBot = useSessionDelegatingBot(session);
  const origin = session.createdBySession;
  const senderSessionId = origin?.sessionId;
  const sourceTarget = parseSourceSessionTarget(senderSessionId);
  const hostDeviceId = session.deviceLinkDeviceId ?? getStickySessionDeviceId(session.id);
  const liveTitle = useLiveOriginTitle(
    sourceTarget?.deviceId ? undefined : senderSessionId,
    Boolean(hostDeviceId),
  );
  const { openTarget: openCrossDeviceTarget } = useSessionLinkTarget(
    sourceTarget?.deviceId
      ? buildSessionDeepLink(sourceTarget.sessionId, { deviceId: sourceTarget.deviceId })
      : '',
  );

  if (!origin || session.orcaRemoteLead || delegatingBot) return null;

  const title = (liveTitle ?? origin.title)?.trim();
  const device = origin.deviceName?.trim()
    || (origin.deviceId ? t('ccAgent.sessionHeader.orcaRemoteLeadUnknownDevice') : '');
  const label = title
    ? t('ccAgent.sessionHeader.createdByTaskNamed', { title })
    : t('ccAgent.sessionHeader.createdByTask');
  const tip = origin.deviceId
    ? title
      ? t('ccAgent.sidebar.origin.createdByRemoteTaskNamed', { device, title })
      : t('ccAgent.sidebar.origin.createdByRemoteTask', { device })
    : title
      ? t('ccAgent.sidebar.origin.createdByTaskNamed', { title })
      : t('ccAgent.sidebar.origin.createdByTask');

  const canNavigate = isInteractiveSessionNavigationMode(navigationMode) && Boolean(sourceTarget);
  const handleOpen = () => {
    if (!sourceTarget) return;
    if (sourceTarget.deviceId) {
      void openCrossDeviceTarget(false).catch(() => toast.error(t('chat.markdownRenderer.openLinkFailed')));
      return;
    }
    if (hostDeviceId) remoteProjectsStore.pinSessionOrigin(hostDeviceId, sourceTarget.sessionId);
    navigate(`/cc-agent/${encodeURIComponent(sourceTarget.sessionId)}`);
  };

  if (!canNavigate) {
    return (
      <Tip text={tip} side="bottom">
        <span
          role="note"
          aria-label={tip}
          data-testid={`session-header-origin-${session.id}`}
          className="ml-1.5 inline-flex h-6 min-w-0 max-w-[200px] shrink items-center gap-1.5 rounded-full px-2 text-12 text-[var(--text-secondary)]"
          style={WINDOW_NO_DRAG_STYLE}
        >
          <CornerDownRight size={12} strokeWidth={1.8} aria-hidden="true" className="shrink-0" />
          <span className="truncate">{label}</span>
        </span>
      </Tip>
    );
  }

  return (
    <Tip text={tip} side="bottom">
      <button
        type="button"
        onClick={handleOpen}
        aria-label={tip}
        data-testid={`session-header-origin-${session.id}`}
        className="ml-1.5 inline-flex h-6 min-w-0 max-w-[200px] shrink items-center gap-1.5 rounded-full px-2 text-12 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        style={WINDOW_NO_DRAG_STYLE}
      >
        <CornerDownRight size={12} strokeWidth={1.8} aria-hidden="true" className="shrink-0" />
        <span className="truncate">{label}</span>
      </button>
    </Tip>
  );
}
