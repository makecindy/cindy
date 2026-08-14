/**
 * OrcaWorkerPanel —— 右侧栏「协同」tab 内的 worker-only 面板。
 *
 * 只承载 Worker 侧能力:worker 列表 / focus 切换 / 新建 / 归档 / 当前 focused worker
 * 会话流。Lead 主会话仍由普通 CCAgentSessionView 渲染,这里不复用 OrcaSplitView 的
 * 双栏布局与独立 resize/maximize。
 */

import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { isAgentIslandSupported } from '@/hooks/useAgentIslandSettings';
import { isSidebarWindow } from '@/lib/sidebarWindow';
import { toast } from '@/lib/toast';
import { CCAgentSessionView } from './CCAgentSessionView';
import { CreateWorkerPopover } from './CreateWorkerPopover';
import { WorkerListToolbar } from './RolePillDropdown';
import { useOrcaWorkerSelection } from './hooks/useOrcaWorkerSelection';
import { subscribeNewWorkerShortcut } from './lib/newWorkerShortcut';
import type { ConversationSearchJump } from '../../../shared/conversationSearchJump';
import { isActiveWorkerStatus } from '../../../shared/orca-worker-status';

export interface OrcaWorkerPanelProps {
  leadSessionId: string;
  /** device-link controlled device that owns the Lead and its Worker team. */
  deviceId?: string;
  /** SSH 远程 Lead:worker 创建面板的模型清单按 SSH 口径过滤(见 CreateWorkerPopover.sshRemote)。 */
  sshRemote?: boolean;
  /** tab active && RSB 未折叠 && 窗口可见。挂载但不可见时不能清红点 / ack 消息。 */
  viewVisible: boolean;
  /** 重型聊天 snapshot 是否实时刷新；隐藏 keep-alive worker pane 会冻结 messages。 */
  chatRealtime?: boolean;
  focusWorkerSessionId?: string | null;
  focusWorkerHintRevision?: number;
  searchJump?: ConversationSearchJump | null;
  onFocusWorkerSessionIdConsumed?: (revision: number) => void;
  onSelectionIntentCleared?: (revision: number) => void;
  onSearchJumpConsumed?: () => void;
  /** Main-window host navigation. Detached sidebar windows omit it and hide the settings action. */
  onOpenSettings?: () => void;
}

function sameVisibleSessionPayload(
  a: string | string[] | null,
  b: string | string[] | null,
): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function OrcaWorkerPanel({
  leadSessionId,
  deviceId,
  sshRemote,
  viewVisible,
  chatRealtime = true,
  focusWorkerSessionId,
  focusWorkerHintRevision,
  searchJump,
  onFocusWorkerSessionIdConsumed,
  onSelectionIntentCleared,
  onSearchJumpConsumed,
  onOpenSettings,
}: OrcaWorkerPanelProps) {
  const { t } = useTranslation();
  const {
    workers,
    focusedWorker,
    activeWorkerCount,
    softLimit,
    hardLimit,
    refreshCreationState,
    selectedWorkerRecord,
    selectedWorkerId,
    workerSessionId,
    createOpen,
    setCreateOpen,
    handleCreateWorker,
    handleSwitchFocus,
    handleArchiveWorker,
  } = useOrcaWorkerSelection({
    leadSessionId,
    deviceId,
    viewVisible,
    focusWorkerSessionId,
    focusWorkerHintRevision,
    searchJump,
    onFocusWorkerSessionIdConsumed,
    onSelectionIntentCleared,
  });
  const lastAgentIslandPayloadRef = useRef<string | string[] | null>(null);

  const handleOpenCreate = useCallback(async () => {
    const result = await refreshCreationState();
    if (result.status !== 'applied') {
      toast.error(t('newChat.collaboration.createWorkerRefreshFailed'));
      return;
    }
    const activeCount = result.workers.filter((worker) =>
      isActiveWorkerStatus(worker.status),
    ).length;
    if (result.hardLimit !== null && activeCount >= result.hardLimit) return;
    setCreateOpen(true);
  }, [refreshCreationState, setCreateOpen, t]);

  useEffect(() => {
    if (!viewVisible) return;
    let active = true;
    const unsubscribe = subscribeNewWorkerShortcut(async () => {
      // Refresh both worker status and authoritative collaboration settings so the shortcut
      // cannot bypass a newly reached or newly lowered hard limit.
      const result = await refreshCreationState();
      if (!active) return true;
      if (result.status !== 'applied') {
        toast.error(t('newChat.collaboration.createWorkerRefreshFailed'));
        return true;
      }
      const activeCount = result.workers.filter((worker) =>
        isActiveWorkerStatus(worker.status),
      ).length;
      if (result.hardLimit !== null && activeCount < result.hardLimit) setCreateOpen(true);
      return true;
    });
    return () => {
      // Prevent an in-flight refresh from opening the dialog after this panel stopped owning the
      // visible collaboration context. No intent is retained for a later mount.
      active = false;
      unsubscribe();
    };
  }, [refreshCreationState, setCreateOpen, t, viewVisible]);

  useEffect(() => {
    if (!isAgentIslandSupported()) return;
    // 可见性归属契约:协同 tab 真正可见时由 worker panel 上报 [lead, worker]；
    // 隐藏、切 tab 或折叠 RSB 时回落为 lead,避免和主 Lead 视图靠 effect 时序抢归属。
    const visibleSessionIds =
      viewVisible && workerSessionId && workerSessionId !== leadSessionId
        ? [leadSessionId, workerSessionId]
        : leadSessionId;
    if (!sameVisibleSessionPayload(lastAgentIslandPayloadRef.current, visibleSessionIds)) {
      lastAgentIslandPayloadRef.current = visibleSessionIds;
      void window.electronAPI.agentIsland?.setVisibleSession?.(visibleSessionIds);
    }
  }, [leadSessionId, viewVisible, workerSessionId]);

  useEffect(() => {
    return () => {
      if (!isAgentIslandSupported()) return;
      if (lastAgentIslandPayloadRef.current !== leadSessionId) {
        lastAgentIslandPayloadRef.current = leadSessionId;
        void window.electronAPI.agentIsland?.setVisibleSession?.(leadSessionId);
      }
    };
  }, [leadSessionId]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-content-area">
      <div className="flex h-8 shrink-0 items-center border-b border-border/40 px-3 text-11 font-medium leading-none text-muted-foreground">
        <WorkerListToolbar
          worker={selectedWorkerRecord ?? focusedWorker}
          workers={workers}
          selectedWorkerId={selectedWorkerId}
          activeWorkerCount={activeWorkerCount}
          softLimit={softLimit}
          hardLimit={hardLimit}
          onSwitchFocus={handleSwitchFocus}
          onOpenCreate={() => void handleOpenCreate()}
          onOpenSettings={() => onOpenSettings?.()}
          settingsEnabled={!isSidebarWindow() && Boolean(onOpenSettings)}
          onArchiveWorker={handleArchiveWorker}
          clearAttentionWhenVisible={viewVisible}
        />
      </div>
      <div className="chat-rail-compact min-h-0 flex-1">
        {workerSessionId ? (
          <CCAgentSessionView
            key={workerSessionId}
            sessionIdProp={workerSessionId}
            compact
            orcaMode
            compactToolbar
            viewVisible={viewVisible}
            chatRealtime={chatRealtime}
            searchJumpProp={searchJump}
            onSearchJumpConsumed={onSearchJumpConsumed}
            navigationMode="sidebar-embedded"
            sidebarTargetSessionId={leadSessionId}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {t('orca.split.waitingForWorker')}
          </div>
        )}
      </div>
      <CreateWorkerPopover
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={handleCreateWorker}
        deviceId={deviceId}
        sshRemote={sshRemote}
      />
    </div>
  );
}
