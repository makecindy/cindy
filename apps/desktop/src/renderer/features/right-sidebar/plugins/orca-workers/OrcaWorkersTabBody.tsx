import { useCallback, useEffect, useMemo } from 'react';
import { MemoryRouter } from 'react-router-dom';

import { useCCSessions } from '@/hooks/useCCSessions';
import { useRemoteProjectSessions } from '@/features/device-link/remoteProjectsStore';
import { OrcaWorkerPanel } from '@/features/cc-agent/OrcaWorkerPanel';
import { useOrcaWorkerAttentionByLeadIds } from '@/features/cc-agent/hooks/useOrcaWorkerAttentionWatcher';
import { useStopOrcaCollabWithoutNavigation } from '@/features/cc-agent/hooks/useStopOrcaCollab';
import {
  revalidateActiveWorkerSettings,
  revalidateActiveWorkersProjection,
  useWorkerProjectionOwner,
} from '@/features/cc-agent/hooks/workerProjectionStore';
import { mergeSessionSources } from '@/features/cc-agent/lib/mergeSessionSources';
import { useDocumentVisible, useWindowVisible } from '@/hooks/useWindowVisible';
import { isSidebarWindow } from '@/lib/sidebarWindow';
import { createLogger } from '@/lib/logger';
import { SidebarHostSessionProvider } from '../../lib/sidebarHostSession';
import type { TabKindBodyProps } from '../../types';
import {
  clearOrcaWorkersSelectionIntent,
  consumeOrcaWorkersFocusHint,
  consumeOrcaWorkersSearchJump,
  type OrcaWorkersState,
} from './actions';
import { getOrcaWorkersCloseDecision } from './closeDecision';

const log = createLogger('OrcaWorkersPlugin');

function RoutedOrcaWorkerPanel(
  props: React.ComponentProps<typeof OrcaWorkerPanel>,
) {
  return <OrcaWorkerPanel {...props} />;
}

export function OrcaWorkersTabBody({
  state,
  ctx,
  active,
  shellVisible = true,
}: {
  state: OrcaWorkersState;
  ctx: TabKindBodyProps<OrcaWorkersState>['ctx'];
  active?: boolean;
  shellVisible?: boolean;
}) {
  useWorkerProjectionOwner(ctx.sessionId);
  const windowVisible = useWindowVisible(Boolean(active && shellVisible));
  const documentVisible = useDocumentVisible(Boolean(active && shellVisible));
  const viewVisible = Boolean(active && shellVisible && windowVisible);
  const chatRealtime = Boolean(active && shellVisible && documentVisible);
  const detachedLeadSessionIds = useMemo(
    () => (isSidebarWindow() ? [ctx.sessionId] : []),
    [ctx.sessionId],
  );
  useOrcaWorkerAttentionByLeadIds(
    detachedLeadSessionIds,
    viewVisible ? ctx.sessionId : undefined,
  );
  const { sessions, isLoading } = useCCSessions();
  const remoteSessions = useRemoteProjectSessions();
  const leadSession =
    mergeSessionSources(sessions, remoteSessions).find(
      (candidate) => candidate.id === ctx.sessionId,
    ) ?? null;
  const closeDecision = getOrcaWorkersCloseDecision({ isLoading, leadSession });
  const { requestStop } = useStopOrcaCollabWithoutNavigation({
    leadSessionId: ctx.sessionId,
  });
  const closeHandler = useCallback(() => {
    if (closeDecision === 'close') return true;
    if (closeDecision === 'stop-team') return requestStop();
    return false;
  }, [closeDecision, requestStop]);

  useEffect(() => ctx.setCloseInterceptor(closeHandler), [closeHandler, ctx]);
  useEffect(() => {
    if (!active || !shellVisible || !windowVisible) return;
    void revalidateActiveWorkersProjection(ctx.sessionId);
    void revalidateActiveWorkerSettings(ctx.sessionId);
  }, [active, ctx.sessionId, shellVisible, windowVisible]);

  const handleFocusWorkerSessionIdConsumed = useCallback(
    (revision: number) => {
      void consumeOrcaWorkersFocusHint(ctx.sessionId, ctx.tabId, revision).catch((err) => {
        log.warn('consume focus worker hint failed', err);
      });
    },
    [ctx],
  );
  const handleSearchJumpConsumed = useCallback(() => {
    void consumeOrcaWorkersSearchJump(
      ctx.sessionId,
      ctx.tabId,
      state.focusWorkerHintRevision ?? 0,
    ).catch((err) => {
      log.warn('consume worker search jump failed', err);
    });
  }, [ctx, state.focusWorkerHintRevision]);
  const handleSelectionIntentCleared = useCallback(
    (revision: number) => {
      void clearOrcaWorkersSelectionIntent(ctx.sessionId, ctx.tabId, revision).catch((err) => {
        log.warn('clear worker selection intent failed', err);
      });
    },
    [ctx],
  );

  const workerPanelProps = {
    leadSessionId: ctx.sessionId,
    deviceId: ctx.deviceLinkDeviceId,
    sshRemote: !!ctx.remoteHostId,
    viewVisible,
    chatRealtime,
    focusWorkerSessionId: state.focusWorkerSessionId,
    focusWorkerHintRevision: state.focusWorkerHintRevision,
    searchJump: state.searchJump,
    onFocusWorkerSessionIdConsumed: handleFocusWorkerSessionIdConsumed,
    onSelectionIntentCleared: handleSelectionIntentCleared,
    onSearchJumpConsumed: handleSearchJumpConsumed,
  };

  return (
    <SidebarHostSessionProvider sessionId={ctx.sessionId}>
      {isSidebarWindow() ? (
        <MemoryRouter initialEntries={[`/cc-agent/${ctx.sessionId}`]}>
          <OrcaWorkerPanel {...workerPanelProps} />
        </MemoryRouter>
      ) : (
        <RoutedOrcaWorkerPanel {...workerPanelProps} />
      )}
    </SidebarHostSessionProvider>
  );
}
