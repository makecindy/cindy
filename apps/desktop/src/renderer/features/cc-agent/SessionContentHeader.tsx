/**
 * SessionContentHeader — 会话视图注入 ContentHeader 的中部内容
 * ---------------------------------------------------------------------------
 * Codex 风格布局后，右侧内容区顶栏（ContentHeader Shell）中部由路由视图注入。
 * 本组件即 cc-agent 会话视图注入的内容：
 *   - Pin 指示 + 会话标题（截断显示，双击进入行内重命名 —— 与 SessionItem 同交互）
 *   - ··· 菜单：与 SessionItem 右键菜单同一套条目、变体与分组顺序（标准 /
 *     Draft / Archived 三分支），含「移动到项目」子菜单与「导出会话…」入口
 *
 * 动作实现说明：
 *   - rename / pin / move 与 CCAgentSidebarUpper 的对应 handler 同款乐观更新 +
 *     失败回滚。pin 不调用 sidebar 的 filter.promotePin、move 不做目标项目
 *     节点的自动展开（两者都是 CCAgentSidebarUpper 实例内 state，header 拿
 *     不到）—— 排序 / 展开走各自的兜底行为，差异可接受。
 *   - archive / delete / unarchive 的执行序列走 useSessionLifecycleActions
 *     （与 CCAgentSidebarUpper 共用同一实现），本组件只保留前置检查与确认
 *     弹窗。操作的恒为"当前打开的会话"，activeSessionId 传 session.id。
 *
 * 拖拽区：本组件渲染在 drag region 内，默认继承窗口拖拽；只有真正需要点击 /
 * 输入的控件挖 no-drag 洞，避免标题和 git 信息整块变成不可拖区域。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Ellipsis, Pin } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import type { Session } from '@/lib/ccAgent.types';
import * as sessionService from '@/lib/sessionService';
import { buildSessionDeepLink } from '@/lib/deepLink';
import { createLogger } from '@/lib/logger';
import {
  prefetchDirtyWorktreeForRemoval,
  resolveWorktreeRemovalPreflight,
} from '@/lib/worktreeRemovalWarning';
import { useCCSessions } from '@/hooks/useCCSessions';
import { useProjectPickerOptions } from '@/hooks/useProjectPickerOptions';
import { useSessionRunningStatus } from '@/hooks/useSessionRunningStatus';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { WINDOW_NO_DRAG_STYLE, useManualWindowDrag } from '@/components/layout/windowDrag';
import { recentWorkdirsStore } from '@/lib/recentWorkdirsStore';
import { useRegisterContentHeader } from '../feature-context';
import { useSessionLifecycleActions } from './hooks/useSessionLifecycleActions';
import {
  getSessionDisplayTitle,
  isEmptyDraftSession,
  toStoredSessionTitle,
} from './lib/sessionDisplayTitle';
import {
  getVisibleSidebarSessionIds,
  pickSessionIdAfterRemoval,
} from './lib/sessionRemovalNavigation';
import { isOrcaLeadSession, resolveSessionRoute } from '@/lib/orcaSessionIdentity';
import { revalidateWorkersProjection } from './hooks/workerProjectionStore';
import { GitContextBadge } from './GitContextBadge';
import { SessionRenameInput } from './SessionRenameInput';
import { useSessionBoundSchedules } from '@/features/scheduler/lib/scheduleSessionBinding';
import { ScheduleBindingBadge } from './sidebar/ScheduleBindingBadge';
import { RemoteProjectIcon } from './sidebar/RemoteProjectIcon';
import {
  MENU_CONTENT_CLASS,
  MENU_ITEM_CLASS,
  MENU_ROW_CLASS,
  MENU_SEPARATOR_CLASS,
  MENU_SUB_CONTENT_CLASS,
} from './sidebar/menuStyles';
import { SessionProjectMoveSubmenu } from './sidebar/SessionProjectMoveSubmenu';
import type { SessionMoveTarget } from './sidebar/sessionMoveTarget';
import { SessionShareExportDialog } from './sidebar/SessionShareExportDialog';
import { SessionBranchTreeDialog } from './SessionBranchTreeDialog';
import { useRemoteProjectSessions } from '@/features/device-link/remoteProjectsStore';
import { isRemoteSessionWriteBlocked } from './lib/remoteSessionWriteGuard';
import { Tip } from '@/components/ui/tooltip';

const log = createLogger('SessionContentHeader');

/**
 * 注册器组件：由路由直挂的 CCAgentSessionView 条件渲染（仅当该实例"拥有"
 * 当前路由时），把 SessionContentHeader 注进 ContentHeader 槽位。
 *
 * 为什么用条件挂载组件而不是在 CCAgentSessionView 里直接调 hook：
 * CCAgentSessionView 会被多处内嵌复用（workdir-browse 的 chat rail、Orca
 * worker 面板都会再挂一个实例）。如果 hook 无条件跑，内嵌实例会用 null /
 * 自己的 session 把路由主实例注册的内容覆盖掉。条件渲染本组件 = 条件执行
 * 注册，卸载时槽位自动清空。
 */
export function SessionContentHeaderRegistration({
  session,
  remoteSessionUnavailable = false,
}: {
  session: Session;
  remoteSessionUnavailable?: boolean;
}) {
  useRegisterContentHeader(
    useMemo(
      () => (
        <SessionContentHeader
          session={session}
          remoteSessionUnavailable={remoteSessionUnavailable}
        />
      ),
      [session, remoteSessionUnavailable],
    ),
  );
  return null;
}

interface SessionContentHeaderProps {
  session: Session;
  remoteSessionUnavailable?: boolean;
}

export function SessionContentHeader({
  session: sessionProp,
  remoteSessionUnavailable = false,
}: SessionContentHeaderProps) {
  const { t } = useTranslation();
  const { sessions, patchLocal } = useCCSessions();
  const remoteProjectSessions = useRemoteProjectSessions();
  const routeSessionById = useMemo(
    () => new Map([...sessions, ...remoteProjectSessions].map((s) => [s.id, s])),
    [sessions, remoteProjectSessions],
  );
  // 显示数据优先取 sessionsStore 的最新快照：本组件的 rename / pin 走
  // patchLocal 乐观更新,store 立即反映;而 prop 来自 CCAgentSessionView 的
  // `serverSession ?? sessionFromList`,其中 serverSession 不订阅 renderer
  // 发起的 update(main 的 sessions:update 不广播 sessions:patched),改名后
  // 会停留在旧值(Codex review P2)。prop 兜底覆盖 archived 等不在
  // active 桶里的会话。
  const session = routeSessionById.get(sessionProp.id) ?? sessionProp;
  const { runningSessionIds } = useSessionRunningStatus(session.id);
  const { confirm: confirmDialog } = useConfirmDialog();
  const { runSessionAction, unarchiveSession } = useSessionLifecycleActions();

  const isPinned = session.pinnedAt != null;
  const isArchived = session.status === 'archived';
  // Draft 判定与 SessionItem 同口径:标题仍是默认哨兵且无消息。
  const isEmpty = isEmptyDraftSession(session);
  const remoteWritesBlocked = remoteSessionUnavailable || isRemoteSessionWriteBlocked(session);
  // 「移动到项目」/「导出会话…」可见性与 SessionItem 同条件。
  const canMoveToProject =
    !isEmpty && !session.remoteHostId && !session.deviceLinkDeviceId && !isArchived;
  // Orca lead 可导出(整个协同随包);Worker 会话流不走此 header 菜单,双保险仍排除。
  const canExportShare =
    !isEmpty &&
    !session.remoteHostId &&
    session.orcaRole !== 'worker' &&
    !session.deviceLinkDeviceId;
  // 导出 HTML:pi 原生 export_html。仅当前打开的本地 pi 会话(需 live 进程应答 RPC),
  // 排除空会话 / 远程 / device-link / archived(archived 无 live 进程)。
  const canExportHtml =
    session.agentKind === 'pi' &&
    !isEmpty &&
    !session.remoteHostId &&
    !session.deviceLinkDeviceId &&
    !isArchived;
  // 手动压缩:pi 原生 compact,同一 live 本地 pi 会话前提(斜杠转义后用户无法手输
  // /compact,这是 pi 会话手动压缩的唯一入口)。回合运行中 pi 拒绝压缩 → 禁用而非隐藏。
  const canCompact = canExportHtml;
  const [compacting, setCompacting] = useState(false);
  const compactDisabled = compacting || runningSessionIds.has(session.id);
  const projectOptions = useProjectPickerOptions();
  // heartbeat schedule 绑定标识,与 SessionItem 同源数据;删除/过期后自动消失。
  const boundSchedules = useSessionBoundSchedules(session.id);
  const displayTitle =
    getSessionDisplayTitle(session, t('ccAgent.common.unnamedSession'))?.trim() ||
    t('ccAgent.sessionHeader.untitled');
  const remoteIconKind = session.deviceLinkDeviceId
    ? 'device-link'
    : session.remoteHostId
      ? 'ssh'
      : null;
  const remoteIconConnectionStatus = session.deviceLinkDeviceId
    ? (session.deviceLinkConnectionStatus ?? 'connected')
    : null;

  /* ---- 行内重命名（与 SessionItem 同交互：双击进入，Enter 提交 / Esc 取消 / Blur 提交，
          输入框本体 + Magic AI 改名按钮统一在 SessionRenameInput） ---- */
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(displayTitle);
  // Enter 提交后 input 卸载又触发 onBlur 的二次提交，用 ref 拦掉。
  const committedRef = useRef(false);

  const showRemoteWriteBlockedToast = useCallback(() => {
    toast.warning(t('ccAgent.remoteSession.actionsUnavailable'));
  }, [t]);

  const startEdit = useCallback(() => {
    if (remoteWritesBlocked) {
      showRemoteWriteBlockedToast();
      return;
    }
    // 预填用 displayTitle,不是原始 session.title —— 后者在未起名的会话上是英文
    // 哨兵,会把 "New Maker" 填进重命名输入框。commitTitle 的 `unchanged` 判据同步
    // 把 displayTitle 也算作「没改」,否则原样回车会把兜底文案写进库冲掉哨兵。
    setEditValue(displayTitle);
    committedRef.current = false;
    setIsEditing(true);
  }, [displayTitle, remoteWritesBlocked, showRemoteWriteBlockedToast]);

  // 标题文字是 no-drag(否则 onDoubleClick 收不到,见 span 处注释),
  // 拖窗习惯由手动拖拽补回:按住标题移动超过死区即拖动窗口。
  const titleManualDrag = useManualWindowDrag();

  // raw 由 SessionRenameInput 传入:输入框当前文本(Magic 生成的标题也先填入输入框,用户 Enter 确认后才走到这里)。
  const commitTitle = useCallback(
    async (raw: string) => {
      if (committedRef.current) return;
      committedRef.current = true;
      const trimmed = raw.trim();
      setIsEditing(false);
      // 「没改」= 与原始标题相同,**或**与预填的显示标题相同。后者不可省:未起名的
      // 会话预填的是本地化兜底文案(「未命名任务」),它不等于库里的英文哨兵 —— 只比
      // session.title 的话,用户双击后原样回车就会把兜底文案写进库、把哨兵冲掉,
      // 自动起名从此永久跳过这个会话(标题永远停在「未命名任务」)。
      const unchanged = !trimmed || trimmed === session.title || trimmed === displayTitle;
      if (remoteWritesBlocked) {
        if (!unchanged) showRemoteWriteBlockedToast();
        return;
      }
      if (unchanged) return;
      // 预填是**显示标题**(legacy automation 会话已剥掉 `[Schedule] ` 前缀),落库前还原,
      // 否则 isAutomationGeneratedSession 认不出它、会话从 automation 分组消失
      // (PR #1031 review P1)。
      const stored = toStoredSessionTitle(session, trimmed);
      const oldTitle = session.title;
      patchLocal(session.id, { title: stored });
      try {
        // 远程会话:patch-meta 经隧道写被控端 → 广播 sessions:patched → applyPatch 更新远程分片
        // (纯镜像,无需重拉);本机会话 patchLocal 已乐观反映。
        await sessionService.patchMeta(session.id, { title: stored });
      } catch (err) {
        log.error('[session rename]', err);
        toast.error(t('ccAgent.sidebar.renameFailed'));
        patchLocal(session.id, { title: oldTitle });
      }
    },
    [
      displayTitle,
      remoteWritesBlocked,
      session.id,
      session.title,
      patchLocal,
      showRemoteWriteBlockedToast,
      t,
    ],
  );

  /* ---- Pin / Unpin ---- */
  const handleTogglePin = useCallback(async () => {
    if (remoteWritesBlocked) {
      showRemoteWriteBlockedToast();
      return;
    }
    const oldPinnedAt = session.pinnedAt;
    const newPinnedAt = isPinned ? null : new Date().toISOString();
    patchLocal(session.id, { pinnedAt: newPinnedAt });
    try {
      // 远程会话:patch-meta → 广播 sessions:patched → applyPatch 更新远程分片(纯镜像)。
      await sessionService.patchMeta(session.id, { pinnedAt: newPinnedAt });
    } catch (err) {
      log.error('[session pin]', err);
      toast.error(t('ccAgent.sidebar.pinFailed'));
      patchLocal(session.id, { pinnedAt: oldPinnedAt });
    }
  }, [
    isPinned,
    patchLocal,
    remoteWritesBlocked,
    session.id,
    session.pinnedAt,
    showRemoteWriteBlockedToast,
    t,
  ]);

  /* ---- 复制任务链接(cindy://session/<id> 深链,与 SessionItem 同语义;
          远程会话把归属设备冻进 ?device=) ---- */
  const handleCopyDeepLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(
        buildSessionDeepLink(session.id, { deviceId: session.deviceLinkDeviceId }),
      );
      toast.success(t('ccAgent.sidebar.deepLink.copied'));
    } catch (err) {
      log.warn('clipboard write failed', err);
      toast.warning(t('ccAgent.sidebar.deepLink.copyFailed'));
    }
  }, [session.deviceLinkDeviceId, session.id, t]);

  const handleOpenInNewWindow = useCallback(() => {
    if (remoteWritesBlocked) {
      showRemoteWriteBlockedToast();
      return;
    }
    void window.electronAPI.maker.openSessionInNewWindow(session.id, session.deviceLinkDeviceId);
  }, [remoteWritesBlocked, session.deviceLinkDeviceId, session.id, showRemoteWriteBlockedToast]);

  /* ---- 移动到项目 / 对话 ----
   * 与 CCAgentSidebarUpper.handleMoveSession 同款守卫(远程不支持 / 执行中 /
   * 被 IM 接管中拦截)与乐观更新 + 失败回滚;不含 sidebar 的目标项目节点自动
   * 展开(collapse 是 CCAgentSidebarUpper 实例内 state,header 拿不到)。 */
  const handleMoveSession = useCallback(
    async (target: SessionMoveTarget) => {
      if (session.remoteHostId || session.deviceLinkDeviceId) {
        toast.warning(t('ccAgent.sidebar.sessionMenu.moveToProjectRemoteUnsupported'));
        return;
      }
      if (runningSessionIds.has(session.id)) {
        toast.warning(t('ccAgent.sidebar.sessionMenu.moveToProjectRunningBlocked'));
        return;
      }
      // Orca lead:team 里任一 worker 在跑时同样不允许移动 workspace(与
      // CCAgentSidebarUpper.effectiveRunningSessionIds 的聚合口径一致)。
      // sidebar 用常驻订阅的 lead→worker map;header 在动作时同步查一次
      // worker 列表,避免依赖挂载初期尚未加载完成的订阅态(Codex review P2)。
      // 查询失败时不阻断,与 sidebar map 拉取失败(空集合)的行为一致。
      if (isOrcaLeadSession(session)) {
        const workers = await revalidateWorkersProjection(session.id)
          .then((result) => (result.status === 'applied' ? result.workers : []))
          .catch(() => []);
        if (workers.some((worker) => runningSessionIds.has(worker.sessionId))) {
          toast.warning(t('ccAgent.sidebar.sessionMenu.moveToProjectRunningBlocked'));
          return;
        }
      }
      try {
        const binding = await window.electronAPI.binding.resolveSession(session.id);
        if (binding.attached) {
          toast.warning(t('ccAgent.sidebar.sessionMenu.moveToProjectAttachedBlocked'));
          return;
        }
      } catch {
        // resolveSession 失败时不阻断移动；它只是 IM 接管保护的额外检查。
      }

      let targetWorkingDir = target.kind === 'project' ? target.workingDir : undefined;
      if (target.kind === 'browseProject') {
        try {
          const result = await window.electronAPI.showOpenDirectoryDialog();
          if (result.canceled || !result.path) return;
          targetWorkingDir = result.path;
        } catch (err) {
          log.warn('[session move to project] directory picker failed', err);
          toast.error(t('ccAgent.sidebar.sessionMenu.moveToProjectFailed'));
          return;
        }
      }

      const oldPatch = {
        workingDir: session.workingDir,
        workspaceKind: session.workspaceKind,
      };
      if (target.kind !== 'dialogue' && !targetWorkingDir) return;
      const nextPatch =
        target.kind === 'dialogue'
          ? { workspaceKind: 'dialogue' as const }
          : { workingDir: targetWorkingDir, workspaceKind: 'project' as const };
      patchLocal(session.id, nextPatch);
      try {
        await sessionService.update(session.id, nextPatch);
        if (target.kind !== 'dialogue') {
          void recentWorkdirsStore.forceRefresh().catch(() => undefined);
        }
        toast.success(
          t(
            target.kind === 'dialogue'
              ? 'ccAgent.sidebar.sessionMenu.moveToDialogueDone'
              : 'ccAgent.sidebar.sessionMenu.moveToProjectDone',
          ),
        );
      } catch (err) {
        log.error('[session move]', err);
        patchLocal(session.id, oldPatch);
        toast.error(
          t(
            target.kind === 'dialogue'
              ? 'ccAgent.sidebar.sessionMenu.moveToDialogueFailed'
              : 'ccAgent.sidebar.sessionMenu.moveToProjectFailed',
          ),
        );
      }
    },
    [patchLocal, runningSessionIds, session, t],
  );

  /* ---- 导出会话(.cshare)---- 弹窗仅打开时挂载,与 SessionItem 同款。 */
  const [shareExportOpen, setShareExportOpen] = useState(false);
  const [branchTreeOpen, setBranchTreeOpen] = useState(false);
  const allKnownSessions = useMemo(
    () => [...sessions, ...remoteProjectSessions],
    [remoteProjectSessions, sessions],
  );
  const hasSessionFamily = useMemo(
    () =>
      allKnownSessions.some(
        (item) => item.parentSessionId === session.id || item.id === session.parentSessionId,
      ),
    [allKnownSessions, session.id, session.parentSessionId],
  );
  const canShowBranchTree = !isEmpty && (session.agentKind === 'pi' || hasSessionFamily);

  /* ---- 手动压缩(pi 原生 compact)---- 长操作(LLM 摘要),压缩边界经事件流自动进聊天;
   * 回合运行中 pi 会拒绝,菜单项据 running 态禁用。compacting 状态在上方派生区声明。 */
  const handleCompactSession = useCallback(async () => {
    if (compacting) return;
    setCompacting(true);
    try {
      const result = await window.electronAPI.maker.compactSession(session.id);
      if (result?.noop) {
        // 良性:上下文太小,无可压缩内容。信息性提示,不是失败。
        toast.info(t('ccAgent.sidebar.sessionMenu.compactNothing'));
      } else if (result) {
        const hasNumbers =
          typeof result.tokensBefore === 'number' &&
          typeof result.estimatedTokensAfter === 'number';
        toast.success(
          hasNumbers
            ? t('ccAgent.sidebar.sessionMenu.compactSuccessWithTokens', {
                before: Math.round((result.tokensBefore ?? 0) / 1000),
                after: Math.round((result.estimatedTokensAfter ?? 0) / 1000),
              })
            : t('ccAgent.sidebar.sessionMenu.compactSuccess'),
        );
      }
      // null:会话无 live 进程 / 不支持(入口已按 gate 隐藏,极少走到)。静默即可。
    } catch (err) {
      log.warn('manual compact failed', err);
      toast.warning(t('ccAgent.sidebar.sessionMenu.compactFailed'));
    } finally {
      setCompacting(false);
    }
  }, [compacting, session.id, t]);

  /* ---- 导出 HTML(pi 原生 export_html)---- 主进程弹保存对话框 + 导出 + 在文件管理器显示。 */
  const [exportingHtml, setExportingHtml] = useState(false);
  const handleExportHtml = useCallback(async () => {
    if (exportingHtml) return;
    setExportingHtml(true);
    try {
      const written = await window.electronAPI.maker.exportSessionHtml(session.id);
      if (written) {
        toast.success(t('ccAgent.sidebar.sessionMenu.exportHtmlSuccess'));
      }
      // written == null:用户取消保存对话框,或会话无 live 进程(未打开)。取消是正常路径,
      // 不打扰;后者极少(本入口只对当前打开会话可见),静默即可。
    } catch (err) {
      log.warn('export session html failed', err);
      toast.warning(t('ccAgent.sidebar.sessionMenu.exportHtmlFailed'));
    } finally {
      setExportingHtml(false);
    }
  }, [exportingHtml, session.id, t]);

  /* ---- Archive / Delete / Unarchive ----
   * 执行序列共用 useSessionLifecycleActions（与 CCAgentSidebarUpper 同一实现）；
   * 本组件只保留前置检查与确认弹窗。header 操作的恒为当前打开的会话，
   * activeSessionId 传 session.id —— archive 后跳 /cc-agent/new、delete 后
   * 优先跳到侧边栏相邻会话，没有相邻项才回新建页。 */
  const handleArchive = useCallback(async () => {
    if (remoteWritesBlocked) {
      showRemoteWriteBlockedToast();
      return;
    }
    // 执行中 / 被 IM 接管中不允许归档 —— 与 sidebar 的 handleActionClick 同规则
    if (runningSessionIds.has(session.id)) {
      toast.warning(t('ccAgent.sidebar.archiveBlocked.running'));
      return;
    }
    // 接管查询先发不 await,让它与菜单打开时那次 prefetch 在链路上重叠;
    // resolveSession 失败降级为「未接管」,不阻断归档(与 sidebar 同口径)。
    const attachedPromise = window.electronAPI.binding
      .resolveSession(session.id)
      .then((binding) => binding.attached)
      .catch(() => false);
    if (await attachedPromise) {
      toast.warning(t('ccAgent.sidebar.archiveBlocked.attached'));
      return;
    }
    // **worktree 预检必须是最后一个前置条件**(codex review):原来这里用 Promise.all
    // 一起等,dirty 先返回 clean、接管查询还在飞的那段时间就是 clean 结论的失效窗口。
    // 改成接管结算之后再 resolve —— clean 一律重查(见 worktreeRemovalWarning),
    // 拿到的是此刻的结论;菜单打开时的 prefetch 仍然热了 git cache。
    const preflight = await resolveWorktreeRemovalPreflight(session.id, session.deviceLinkDeviceId);
    // 归档不弹确认框 —— 可逆操作(菜单里就有「恢复」),与 sidebar 同口径。
    // 免确认的判据是「**确认**干净」:worktree 脏、或预检失败拿不到结论('unknown')
    // 都要确认 —— 归档会顺带回收 worktree,不能静默带走改动(greptile review)。
    // 'unknown' 只弹普通归档确认,不摆 dirty 警告文案(那会谎称有未提交改动)。
    if (preflight !== 'clean') {
      const ok = await confirmDialog({
        title: t('ccAgent.sidebar.confirmArchive.title'),
        description:
          t('ccAgent.sidebar.confirmArchive.description') +
          (preflight === 'dirty'
            ? ' ' + t('ccAgent.sidebar.confirmArchive.dirtyWorktreeWarning')
            : ''),
        confirmText: t('ccAgent.sidebar.confirmArchive.confirm'),
        cancelText: t('ccAgent.sidebar.confirmArchive.cancel'),
      });
      if (!ok) return;
    }
    await runSessionAction(session.id, 'archive', { activeSessionId: session.id });
  }, [
    confirmDialog,
    remoteWritesBlocked,
    runSessionAction,
    runningSessionIds,
    session.deviceLinkDeviceId,
    session.id,
    showRemoteWriteBlockedToast,
    t,
  ]);

  const handleUnarchive = useCallback(async () => {
    if (remoteWritesBlocked) {
      showRemoteWriteBlockedToast();
      return;
    }
    await unarchiveSession(session.id);
  }, [remoteWritesBlocked, session.id, showRemoteWriteBlockedToast, unarchiveSession]);

  const handleDelete = useCallback(async () => {
    if (remoteWritesBlocked) {
      showRemoteWriteBlockedToast();
      return;
    }
    // P1 预检:worktree 有未提交更改时确认文案追加警告。删除始终弹确认框,所以
    // 用不到三态 —— 预检失败时少一行警告文案,不会变成静默放行。
    const dirtyWorktree =
      (await resolveWorktreeRemovalPreflight(session.id, session.deviceLinkDeviceId)) === 'dirty';
    const ok = await confirmDialog({
      title: t('ccAgent.sidebar.confirmDelete.title'),
      description:
        t('ccAgent.sidebar.confirmDelete.description') +
        (dirtyWorktree ? ' ' + t('ccAgent.sidebar.confirmDelete.dirtyWorktreeWarning') : ''),
      confirmText: t('ccAgent.sidebar.confirmDelete.confirm'),
      cancelText: t('ccAgent.sidebar.confirmDelete.cancel'),
    });
    if (!ok) return;
    const visibleSessionIds = getVisibleSidebarSessionIds();
    const hasVisibleListContext = visibleSessionIds.includes(session.id);
    const nextSessionId = pickSessionIdAfterRemoval(
      visibleSessionIds,
      new Set([session.id]),
      session.id,
    );
    const deleteRedirectRoute = nextSessionId
      ? await resolveSessionRoute(nextSessionId, routeSessionById.get(nextSessionId))
      : hasVisibleListContext
        ? '/cc-agent/new'
        : null;
    await runSessionAction(session.id, 'delete', {
      activeSessionId: session.id,
      deleteRedirectRoute,
    });
  }, [
    confirmDialog,
    remoteWritesBlocked,
    routeSessionById,
    runSessionAction,
    session.id,
    showRemoteWriteBlockedToast,
    t,
  ]);

  return (
    <div className="flex min-w-0 items-center gap-0.5 pl-1">
      {isPinned && (
        <Pin
          size={13}
          className="mr-1 shrink-0 text-[var(--cmd-palette-item-meta)]"
          aria-label={t('ccAgent.sidebar.sessionMenu.pin')}
        />
      )}
      {boundSchedules.length > 0 && (
        <span style={WINDOW_NO_DRAG_STYLE}>
          <ScheduleBindingBadge schedules={boundSchedules} size={13} className="mr-1 size-4" />
        </span>
      )}
      {!isEditing && remoteIconKind && (
        <Tip
          text={
            session.deviceLinkDeviceName ?? session.deviceLinkDeviceId ?? session.remoteHostId ?? ''
          }
        >
          <RemoteProjectIcon
            kind={remoteIconKind}
            connectionStatus={remoteIconConnectionStatus}
            className="mr-1 text-[var(--cmd-palette-item-meta)]"
          />
        </Tip>
      )}

      {isEditing ? (
        <div style={WINDOW_NO_DRAG_STYLE}>
          <SessionRenameInput
            sessionId={session.id}
            value={editValue}
            onValueChange={setEditValue}
            onCommit={(raw) => void commitTitle(raw)}
            onCancel={() => {
              // 标记已提交再退出编辑：input 卸载会触发 onBlur → commitTitle,
              // 不拦住的话 Esc"取消"反而会把改了一半的标题保存掉(Codex review P2)。
              committedRef.current = true;
              setIsEditing(false);
            }}
            containerClassName="w-72 max-w-[40vw]"
            inputClassName="h-7 text-sm font-medium text-foreground"
          />
        </div>
      ) : (
        // 标题文字必须挖 no-drag 洞:留在 drag region 里的话全部鼠标事件都被
        // 原生拖拽吞掉(连 mousedown 都收不到),onDoubleClick 永远触发不了。
        // 拖窗习惯由 useManualWindowDrag 手动补回:按住标题移动照样拖窗,
        // 双击(死区内)不动窗、正常进入改名。
        <span
          {...titleManualDrag}
          onDoubleClick={startEdit}
          title={displayTitle}
          className="min-w-0 max-w-[40vw] cursor-default truncate text-sm font-medium text-foreground"
          style={WINDOW_NO_DRAG_STYLE}
        >
          {displayTitle}
        </span>
      )}

      {!isEditing && (
        // 菜单打开就把归档/删除的 dirty 预检发出去:用户从展开菜单到点条目至少
        // 一次反应时间,足够这次 git status 跑完,点下去时命中缓存、零等待。
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) prefetchDirtyWorktreeForRemoval(session.id, session.deviceLinkDeviceId);
          }}
        >
          <DropdownMenuTrigger asChild>
            <button
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
                'text-[var(--cmd-palette-item-meta)] transition-colors',
                'hover:bg-titlebar-button-hover hover:text-foreground',
                'focus-visible:outline-none data-[state=open]:bg-titlebar-button-hover',
              )}
              aria-label={t('ccAgent.sessionHeader.moreActions')}
              style={WINDOW_NO_DRAG_STYLE}
            >
              <Ellipsis size={15} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            sideOffset={4}
            className={cn(MENU_CONTENT_CLASS, 'min-w-32 overflow-hidden')}
          >
            {/* 菜单变体、条目与分组顺序对齐 SessionItem 右键菜单：
                - Archived：Rename / Unarchive / [导出会话] / Copy ‖ Delete
                - Draft：Rename / Copy ‖ Delete
                - 标准：Pin↔Unpin / Rename / [移动到项目 ▸] ‖ Copy / 新窗口打开 /
                  [导出会话] ‖ Archive / Delete */}
            {isArchived ? (
              <>
                <DropdownMenuItem
                  disabled={remoteWritesBlocked}
                  onSelect={startEdit}
                  className={MENU_ITEM_CLASS}
                >
                  {t('ccAgent.sidebar.sessionMenu.rename')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={remoteWritesBlocked}
                  onSelect={() => void handleUnarchive()}
                  className={MENU_ITEM_CLASS}
                >
                  {t('ccAgent.sidebar.sessionMenu.unarchive')}
                </DropdownMenuItem>
                {canExportShare && (
                  <DropdownMenuItem
                    onSelect={() => setShareExportOpen(true)}
                    className={MENU_ITEM_CLASS}
                  >
                    {t('ccAgent.sidebar.sessionMenu.exportShare')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onSelect={() => void handleCopyDeepLink()}
                  className={MENU_ITEM_CLASS}
                >
                  {t('ccAgent.sidebar.sessionMenu.copySessionLink')}
                </DropdownMenuItem>
                {canShowBranchTree && (
                  <DropdownMenuItem
                    onSelect={() => setBranchTreeOpen(true)}
                    className={MENU_ITEM_CLASS}
                  >
                    {t('ccAgent.sidebar.sessionMenu.sessionBranches')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />
                <DropdownMenuItem
                  disabled={remoteWritesBlocked}
                  onSelect={() => void handleDelete()}
                  className={MENU_ITEM_CLASS}
                >
                  {t('ccAgent.sidebar.sessionMenu.delete')}
                </DropdownMenuItem>
              </>
            ) : isEmpty ? (
              <>
                <DropdownMenuItem
                  disabled={remoteWritesBlocked}
                  onSelect={startEdit}
                  className={MENU_ITEM_CLASS}
                >
                  {t('ccAgent.sidebar.sessionMenu.rename')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => void handleCopyDeepLink()}
                  className={MENU_ITEM_CLASS}
                >
                  {t('ccAgent.sidebar.sessionMenu.copySessionLink')}
                </DropdownMenuItem>
                <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />
                <DropdownMenuItem
                  disabled={remoteWritesBlocked}
                  onSelect={() => void handleDelete()}
                  className={MENU_ITEM_CLASS}
                >
                  {t('ccAgent.sidebar.sessionMenu.delete')}
                </DropdownMenuItem>
              </>
            ) : (
              <>
                <DropdownMenuItem
                  disabled={remoteWritesBlocked}
                  onSelect={() => void handleTogglePin()}
                  className={MENU_ITEM_CLASS}
                >
                  {isPinned
                    ? t('ccAgent.sidebar.sessionMenu.unpin')
                    : t('ccAgent.sidebar.sessionMenu.pin')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={remoteWritesBlocked}
                  onSelect={startEdit}
                  className={MENU_ITEM_CLASS}
                >
                  {t('ccAgent.sidebar.sessionMenu.rename')}
                </DropdownMenuItem>
                {canMoveToProject && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger className={MENU_ROW_CLASS}>
                      <span className="flex-1">
                        {t('ccAgent.sidebar.sessionMenu.moveToProject')}
                      </span>
                      <ChevronRight
                        size={14}
                        className="ml-2 shrink-0 text-[var(--cmd-palette-item-meta)]"
                      />
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent
                      sideOffset={4}
                      className={cn(MENU_SUB_CONTENT_CLASS, 'w-[320px] overflow-hidden')}
                    >
                      <SessionProjectMoveSubmenu
                        projectOptions={projectOptions}
                        currentWorkingDir={
                          session.workspaceKind === 'project' ? session.workingDir : null
                        }
                        isDialogue={session.workspaceKind === 'dialogue'}
                        onSelectProject={(workingDir) =>
                          void handleMoveSession({ kind: 'project', workingDir })
                        }
                        onBrowseProject={() => void handleMoveSession({ kind: 'browseProject' })}
                        onMoveToDialogue={() => void handleMoveSession({ kind: 'dialogue' })}
                      />
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />
                <DropdownMenuItem
                  onSelect={() => void handleCopyDeepLink()}
                  className={MENU_ITEM_CLASS}
                >
                  {t('ccAgent.sidebar.sessionMenu.copySessionLink')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={remoteWritesBlocked}
                  onSelect={handleOpenInNewWindow}
                  className={MENU_ITEM_CLASS}
                >
                  {t('ccAgent.sidebar.sessionMenu.openInNewWindow')}
                </DropdownMenuItem>
                {canShowBranchTree && (
                  <DropdownMenuItem
                    onSelect={() => setBranchTreeOpen(true)}
                    className={MENU_ITEM_CLASS}
                  >
                    {t('ccAgent.sidebar.sessionMenu.sessionBranches')}
                  </DropdownMenuItem>
                )}
                {canExportShare && (
                  <DropdownMenuItem
                    onSelect={() => setShareExportOpen(true)}
                    className={MENU_ITEM_CLASS}
                  >
                    {t('ccAgent.sidebar.sessionMenu.exportShare')}
                  </DropdownMenuItem>
                )}
                {canExportHtml && (
                  <DropdownMenuItem
                    disabled={exportingHtml}
                    onSelect={() => void handleExportHtml()}
                    className={MENU_ITEM_CLASS}
                  >
                    {t('ccAgent.sidebar.sessionMenu.exportHtml')}
                  </DropdownMenuItem>
                )}
                {canCompact && (
                  <DropdownMenuItem
                    disabled={compactDisabled}
                    onSelect={() => void handleCompactSession()}
                    className={MENU_ITEM_CLASS}
                  >
                    {compacting
                      ? t('ccAgent.sidebar.sessionMenu.compacting')
                      : t('ccAgent.sidebar.sessionMenu.compact')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />
                <DropdownMenuItem
                  disabled={remoteWritesBlocked}
                  onSelect={() => void handleArchive()}
                  className={MENU_ITEM_CLASS}
                >
                  {t('ccAgent.sidebar.sessionMenu.archived')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={remoteWritesBlocked}
                  onSelect={() => void handleDelete()}
                  className={MENU_ITEM_CLASS}
                >
                  {t('ccAgent.sidebar.sessionMenu.delete')}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* session-git-pr-context:当前分支 + 关联 PR 徽标(非 git 目录 / dialogue 会话自动隐藏) */}
      <GitContextBadge session={session} />

      {/* 导出 .cshare 弹窗:仅打开时挂载,与 SessionItem 同款。 */}
      {shareExportOpen && (
        <SessionShareExportDialog
          open={shareExportOpen}
          sessionId={session.id}
          onOpenChange={setShareExportOpen}
        />
      )}
      {branchTreeOpen && (
        <SessionBranchTreeDialog
          open={branchTreeOpen}
          onOpenChange={setBranchTreeOpen}
          session={session}
          sessions={allKnownSessions}
          running={runningSessionIds.has(session.id)}
          writeBlocked={remoteWritesBlocked}
        />
      )}
    </div>
  );
}
