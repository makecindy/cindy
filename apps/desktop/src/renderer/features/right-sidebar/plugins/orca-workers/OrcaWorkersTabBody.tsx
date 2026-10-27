import { useCallback, useEffect, useMemo, useRef } from 'react';
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
import { mergeSidebarWindowBack } from '../../lib/mergeSidebarWindowBack';
import { SidebarHostSessionProvider } from '../../lib/sidebarHostSession';
import type { TabKindBodyProps } from '../../types';
import {
  clearOrcaWorkersSelectionIntent,
  consumeOrcaWorkersFocusHint,
  consumeOrcaWorkersSearchJump,
  writeOrcaWorkersFocusIntent,
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

  // 分离窗合并回主窗期间，本窗不消费刚写入的 Worker 意图：消费会把意图清掉并落库，
  // 主窗重新水合时就读不到要选中的 Worker 了。
  const mergingBackRef = useRef(false);
  const handleFocusWorkerSessionIdConsumed = useCallback(
    (revision: number) => {
      if (mergingBackRef.current) return;
      void consumeOrcaWorkersFocusHint(ctx.sessionId, ctx.tabId, revision).catch((err) => {
        log.warn('consume focus worker hint failed', err);
      });
    },
    [ctx],
  );
  const handleViewWorkerInMainWindow = useCallback(
    (workerSessionId: string) => {
      if (mergingBackRef.current) return;
      mergingBackRef.current = true;
      void (async () => {
        let revision: number | null = null;
        try {
          // 先等意图写完(可持久化会话落库)，再交接；主窗收回后据此选中该 Worker。
          revision = await writeOrcaWorkersFocusIntent(ctx.sessionId, ctx.tabId, workerSessionId);
          await mergeSidebarWindowBack(ctx.sessionId);
        } catch (err) {
          mergingBackRef.current = false;
          log.warn('view worker in main window failed', err);
          // 本窗的选择 hook 对同一 revision 只回调一次消费，合并期间那次被跳过了；
          // 合并失败时补消费，免得这条意图留在 tab 状态里，下次挂载又被重放。
          if (revision !== null) handleFocusWorkerSessionIdConsumed(revision);
        }
      })();
    },
    [ctx, handleFocusWorkerSessionIdConsumed],
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
    agentDeviceId: leadSession ? (leadSession.agentDeviceId ?? null) : undefined,
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
          <OrcaWorkerPanel
            {...workerPanelProps}
            onViewWorkerInMainWindow={handleViewWorkerInMainWindow}
          />
        </MemoryRouter>
      ) : (
        <RoutedOrcaWorkerPanel {...workerPanelProps} />
      )}
    </SidebarHostSessionProvider>
  );
}
