/**
 * OrcaWorkerPanel —— 右侧栏「协同」tab 内的 worker-only 面板。
 *
 * 只承载 Worker 侧能力:worker 列表 / focus 切换 / 新建 / 归档 / 当前 focused worker
 * 会话流。Lead 主会话仍由普通 CCAgentSessionView 渲染,这里不复用 OrcaSplitView 的
 * 双栏布局与独立 resize/maximize。
 */

import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { isAgentIslandSupported } from '@/hooks/useAgentIslandSettings';
import { useAgentCapabilities } from '@/hooks/useAgentCapabilities';
import { toast } from '@/lib/toast';
import { isSidebarWindow } from '@/lib/sidebarWindow';
import { CCAgentSessionView } from './CCAgentSessionView';
import { CreateWorkerPopover } from './CreateWorkerPopover';
import { EditWorkerPopover } from './EditWorkerPopover';
import { RemoteWorkerSessionPane } from './RemoteWorkerSessionPane';
import { WorkerListToolbar } from './RolePillDropdown';
import { useOrcaWorkerSelection } from './hooks/useOrcaWorkerSelection';
import { useWorkerAgentDevices } from './hooks/useWorkerAgentDevices';
import { subscribeNewWorkerShortcut } from './lib/newWorkerShortcut';
import type { ConversationSearchJump } from '../../../shared/conversationSearchJump';
import { isActiveWorkerStatus } from '../../../shared/orca-worker-status';

export interface OrcaWorkerPanelProps {
  leadSessionId: string;
  /**
   * device-link 受控设备：string = 被控设备(远程)，null = 已确认本机，undefined = 归属尚未解析。
   * 本地设置跳转只在归属解析为 null(本机)时启用，未解析时 fail closed，
   * 避免冷启动 / relay 重连竞态把远端上限误当成本机可调。
   */
  deviceId?: string | null;
  /** Lead 的 Agent 运行设备：null = 已确认本机，undefined = 任务信息尚未解析。 */
  agentDeviceId?: string | null;
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
  /**
   * 分离侧栏窗口专用：合并回主窗口并在主窗协同 tab 选中该 Worker。分离窗只有收窄的
   * preload 和轻量入口，撑不起完整聊天视图，所以这里不嵌入 Worker 对话。
   */
  onViewWorkerInMainWindow?: (workerSessionId: string) => void;
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
  agentDeviceId,
  sshRemote,
  viewVisible,
  chatRealtime = true,
  focusWorkerSessionId,
  focusWorkerHintRevision,
  searchJump,
  onFocusWorkerSessionIdConsumed,
  onSelectionIntentCleared,
  onSearchJumpConsumed,
  onViewWorkerInMainWindow,
}: OrcaWorkerPanelProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // 分离窗只显示占位、不显示 Worker 对话：不能当作用户在看这个 Worker，
  // 否则「已完成」会被自动确认、提醒也会被清掉。
  const workerConversationVisible = viewVisible && !isSidebarWindow();
  // Worker 可以放 Agent 的其他电脑与分享；Lead 的 Agent 位置未解析时不提供，Worker 跟 Lead。
  const workerAgentDevices = useWorkerAgentDevices({
    controlledDeviceId: agentDeviceId === undefined ? undefined : deviceId,
    leadAgentDeviceId: agentDeviceId,
    sshRemote,
  });
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
    editWorker,
    handleCloseEditWorker,
    handleOpenEditWorker,
    handleUpdateWorker,
    handleCreateWorker,
    handleSwitchFocus,
    handleArchiveWorker,
  } = useOrcaWorkerSelection({
    leadSessionId,
    deviceId: deviceId ?? undefined,
    viewVisible: workerConversationVisible,
    focusWorkerSessionId,
    focusWorkerHintRevision,
    searchJump,
    onFocusWorkerSessionIdConsumed,
    onSelectionIntentCleared,
  });
  const lastAgentIslandPayloadRef = useRef<string | string[] | null>(null);
  const shownWorker = selectedWorkerRecord ?? focusedWorker;
  // 在另一台电脑运行的 Worker：本机代理任务不跑 Agent，展示运行设备上的真实任务。
  const remoteDevice =
    shownWorker && shownWorker.sessionId === workerSessionId
      ? shownWorker.executionDevice
      : undefined;

  // 改名入口的远程兼容门:归属已确认本机时始终可编辑；device-link 被控端必须显式
  // 声明支持 maker:worker:update(旧被控端 allowlist 不认该 channel)。
  // 归属未解析(undefined)与「设置」入口同口径 fail closed。
  const editingRemote = typeof deviceId === 'string';
  const editCapabilities = useAgentCapabilities(
    (selectedWorkerRecord ?? focusedWorker)?.agent ?? 'codex',
    editingRemote ? deviceId : undefined,
  );
  const canEditWorker =
    deviceId !== undefined &&
    (!editingRemote || editCapabilities.capabilities?.supportsOrcaWorkerUpdate === true);

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

  // 硬上限时 + 按钮不再只是 disabled no-op，而是跳转到协同设置去调高上限（codex P1 逃生口）。
  // 但两类面板不接线跳转（onOpenSettings 传 undefined，+ 按钮回退为 disabled）：
  // 1) 分离侧栏窗口固定在 /sidebar-window 壳路由，本地 navigate 会把辅助窗口整壳替换成主设置
  //    路由，与 CreateWorkerPopover 的 onNavigateToProviders 同口径；
  // 2) device-link 受控 Lead（deviceId 面板）：其 worker 上限走 device-link Orca 路径，
  //    本地 /settings?section=collaboration 读写的是本机 localDb.orcaWorkflows，改不动远程上限。
  const handleOpenSettings = useCallback(() => {
    navigate('/settings?section=collaboration');
  }, [navigate]);

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
    // 分离窗只显示占位,Worker 对话不可见,同样回落为 lead。
    const visibleSessionIds =
      workerConversationVisible && workerSessionId && workerSessionId !== leadSessionId
        ? [leadSessionId, workerSessionId]
        : leadSessionId;
    if (!sameVisibleSessionPayload(lastAgentIslandPayloadRef.current, visibleSessionIds)) {
      lastAgentIslandPayloadRef.current = visibleSessionIds;
      void window.electronAPI.agentIsland?.setVisibleSession?.(visibleSessionIds);
    }
  }, [leadSessionId, workerConversationVisible, workerSessionId]);

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
          leadSessionId={leadSessionId}
          worker={selectedWorkerRecord ?? focusedWorker}
          workers={workers}
          selectedWorkerId={selectedWorkerId}
          activeWorkerCount={activeWorkerCount}
          softLimit={softLimit}
          hardLimit={hardLimit}
          onSwitchFocus={handleSwitchFocus}
          onOpenCreate={() => void handleOpenCreate()}
          onOpenSettings={isSidebarWindow() || deviceId !== null ? undefined : handleOpenSettings}
          onArchiveWorker={handleArchiveWorker}
          onEditWorker={canEditWorker ? handleOpenEditWorker : undefined}
          clearAttentionWhenVisible={workerConversationVisible}
        />
      </div>
      <div className="chat-rail-compact min-h-0 flex-1">
        {workerSessionId && isSidebarWindow() ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-sm text-muted-foreground">
              {t('orca.split.workerHiddenInSeparateWindow')}
            </p>
            {onViewWorkerInMainWindow && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onViewWorkerInMainWindow(workerSessionId)}
              >
                {t('orca.split.viewWorkerInMainWindow')}
              </Button>
            )}
          </div>
        ) : workerSessionId && remoteDevice ? (
          <RemoteWorkerSessionPane
            key={workerSessionId}
            leadSessionId={leadSessionId}
            device={remoteDevice}
            viewVisible={viewVisible}
            chatRealtime={chatRealtime}
          />
        ) : workerSessionId ? (
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
        leadSessionId={leadSessionId}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={handleCreateWorker}
        deviceId={deviceId ?? undefined}
        sshRemote={sshRemote}
        // 工作电脑与 Lead 的 Agent 位置独立；SSH 沿用原限制。
        executionDevicesEnabled={deviceId === null && !sshRemote}
        // Worker 的模型目录默认跟 Lead 的 Agent 所在电脑；远控时由任务所在电脑代读。
        leadAgentDeviceId={workerAgentDevices.leadAgentDeviceId}
        remoteAgentDevices={workerAgentDevices.devices}
        catalogHostDeviceId={workerAgentDevices.catalogHostDeviceId}
      />
      <EditWorkerPopover
        open={!!editWorker}
        worker={editWorker}
        onClose={handleCloseEditWorker}
        onSave={handleUpdateWorker}
      />
    </div>
  );
}
