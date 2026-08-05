/**
 * orca-workers plugin —— 右侧栏「协同」tab。
 *
 * 协同 tab 不出现在 AddTabDropdown;只由 reveal / ensure 入口自动创建。
 * 关闭 tab 等价于结束协同,由 TabBody 注册 close interceptor 弹确认并执行
 * disableOrca；body 未挂载时 onBeforeClose fail-closed,拒绝误关协同。
 */

import { useCallback, useEffect, useMemo } from 'react';
import { UsersRound } from 'lucide-react';
import type { TFunction } from 'i18next';

import { AttentionDot } from '@/components/sidebar/AttentionDot';
import { useCCSessions } from '@/hooks/useCCSessions';
import { useRemoteProjectSessions } from '@/features/device-link/remoteProjectsStore';
import { OrcaWorkerPanel } from '@/features/cc-agent/OrcaWorkerPanel';
import { useOrcaWorkerAttentionByLeadIds } from '@/features/cc-agent/hooks/useOrcaWorkerAttentionWatcher';
import { useStopOrcaCollab } from '@/features/cc-agent/hooks/useStopOrcaCollab';
import {
  revalidateActiveWorkerSettings,
  revalidateActiveWorkersProjection,
  useWorkerProjection,
  useWorkerProjectionOwner,
} from '@/features/cc-agent/hooks/workerProjectionStore';
import { mergeSessionSources } from '@/features/cc-agent/lib/mergeSessionSources';
import { useWorkerAttentionSnapshot } from '@/features/cc-agent/lib/workerAttentionStore';
import { useDocumentVisible, useWindowVisible } from '@/hooks/useWindowVisible';
import { isOrcaLeadSession } from '@/lib/orcaSessionIdentity';
import { isSidebarWindow } from '@/lib/sidebarWindow';
import * as sessionService from '@/lib/sessionService';
import { createLogger } from '@/lib/logger';
import { registerTabKind } from '../../registry';
import { hasTabCloseInterceptor } from '../../store';
import type { TabKindPlugin } from '../../types';
import {
  clearOrcaWorkersSelectionIntent,
  consumeOrcaWorkersFocusHint,
  consumeOrcaWorkersSearchJump,
  hydrateOrcaWorkersState,
  type OrcaWorkersState,
} from './actions';
import { getOrcaWorkersCloseDecision } from './closeDecision';

const log = createLogger('OrcaWorkersPlugin');

function OrcaWorkersTabPillTitle({ t }: { state: OrcaWorkersState; t: TFunction }) {
  return <>{t('rightSidebar.tabs.kinds.collaboration')}</>;
}

function OrcaWorkersTabPillIcon({
  sessionId,
  active,
}: {
  state: OrcaWorkersState;
  sessionId: string | null;
  active: boolean;
}) {
  return (
    <span className="relative inline-flex">
      <UsersRound size={13} />
      {!active && sessionId && <OrcaWorkersAttentionDot sessionId={sessionId} />}
    </span>
  );
}

function OrcaWorkersAttentionDot({ sessionId }: { sessionId: string }) {
  const attention = useWorkerAttentionSnapshot();
  const projection = useWorkerProjection(sessionId);
  const hasAttention = projection.workers.some((worker) => attention.has(worker.workerId));
  if (!hasAttention) return null;

  return (
    <span
      aria-label="unread"
      className="absolute -right-[3px] -top-[3px] inline-flex rounded-full"
      style={{ boxShadow: '0 0 0 1.5px var(--surface)' }}
    >
      <AttentionDot size={6} />
    </span>
  );
}

function OrcaWorkersTabBody({
  state,
  ctx,
  active,
  shellVisible = true,
}: {
  state: OrcaWorkersState;
  ctx: Parameters<TabKindPlugin<OrcaWorkersState>['TabBody']>[0]['ctx'];
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
  const { requestStop } = useStopOrcaCollab({
    leadSessionId: ctx.sessionId,
    navigateOnSuccess: false,
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
      // 消费 string 只清 payload、不递增 revision；hook 因而保留刚建立的 pin。
      // 外部显式 null 会经 actions 递增 revision，mounted hook 才会立即清 pin。
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

  return (
    <OrcaWorkerPanel
      leadSessionId={ctx.sessionId}
      deviceId={leadSession?.deviceLinkDeviceId}
      // SSH 远程 Lead:worker 创建面板按 SSH 口径过滤模型清单(与 main 侧
      // remote-worker guard 同规则,codex review R28)。
      sshRemote={!!leadSession?.remoteHostId}
      viewVisible={viewVisible}
      chatRealtime={chatRealtime}
      focusWorkerSessionId={state.focusWorkerSessionId}
      focusWorkerHintRevision={state.focusWorkerHintRevision}
      searchJump={state.searchJump}
      onFocusWorkerSessionIdConsumed={handleFocusWorkerSessionIdConsumed}
      onSelectionIntentCleared={handleSelectionIntentCleared}
      onSearchJumpConsumed={handleSearchJumpConsumed}
    />
  );
}

const plugin: TabKindPlugin<OrcaWorkersState> = {
  kind: 'orca-workers',
  menu: {
    kind: 'orca-workers',
    labelKey: 'rightSidebar.tabs.kinds.collaboration',
    icon: UsersRound,
    order: 18,
    enabled: true,
    hiddenFromMenu: true,
    singleton: true,
  },
  TabPillTitle: OrcaWorkersTabPillTitle,
  TabPillIcon: OrcaWorkersTabPillIcon,
  TabBody: OrcaWorkersTabBody,
  defaultState: () => ({}),
  hydrateState: hydrateOrcaWorkersState,
  onBeforeClose: async (_state, ctx) => {
    if (hasTabCloseInterceptor(ctx.tabId)) return true;
    const leadSession = await sessionService.get(ctx.sessionId).catch(() => null);
    if (leadSession && !isOrcaLeadSession(leadSession)) return true;
    return false;
  },
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
