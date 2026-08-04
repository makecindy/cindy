/**
 * SchedulerPage — /schedules 主路由（master-detail 改版）
 * ---------------------------------------------------------------------------
 * - 列表为空 → 居中 EmptyState（统一秒表图标 + 文案 + New Automation 按钮）
 * - 列表非空 → master-detail：
 *     左 TaskListPane (300w，按 lastFiredAt desc 排) + 右 RunHistoryPane (flex)
 *
 * 排序变化：从原"按状态分组(active/paused/expired)"改成"统一按 lastFiredAt 降序"
 * （用户对齐：列表更直观地看到"最近一次执行的任务"）。
 *
 * selectedId 维护：
 *   1. URL ?focus=<id> 命中 → 选中
 *   2. 已选项还在 sorted 里 → 保持
 *   3. 否则 → sorted 第一条
 *   被删 / 被过滤掉 → 自动回退到 sorted 第一条
 *
 * 切换选中 task 时 RunHistoryPane **不 remount**（无 key prop）：让内部 useRuns
 * 在 scheduleId 切换期间继续显示旧 runs，新数据到达再原子替换，避免空帧闪烁。
 * （旧实现加了 key={selectedId} 来"防止旧卡片残留"，但实际效果是切任务时整面板
 * 销毁重建，body 出现 hasLoaded=false 的空白帧 —— 用户感知是闪烁，反而更糟。
 * 现在跟 CLAUDE.md §12 对齐：先异步取数据，拿到再刷新显示。）
 *
 * 列表实时刷新：useSchedules 内部订阅 maker.schedule.onEvent，
 *   'changed' 触发 refresh（**禁** setInterval 轮询）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Timer } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { WINDOW_DRAG_STYLE, WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { toast } from '@/lib/toast';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { normalizeWorkingDir } from '@/features/cc-agent/lib/projectGrouping';
import type {
  Schedule,
  CreateScheduleInput,
  ScheduleTemplate,
  UpdateScheduleInput,
} from '@cindy/maker-scheduler';

import { useHorizontalResize } from '@/hooks/useHorizontalResize';

import { useSchedules } from './hooks/useSchedules';
import { useDeleteScheduleWithSessions } from './hooks/useDeleteScheduleWithSessions';
import { useScheduleUnreadRunCounts } from './hooks/useScheduleUnreadRunCounts';
import { useScheduleCostSummaries } from './hooks/useScheduleCostSummaries';
import { useRunNowBusyGuard } from './hooks/useRunNowBusyGuard';
import { ScheduleFormDialog } from './components/ScheduleFormDialog';
import { TemplateGallery } from './components/TemplateGallery';
import { TaskListPane } from './components/TaskListPane';
import { RunHistoryPane } from './components/RunHistoryPane';
import type { StatusFilter } from './components/TaskListFilterPopover';
import { loadStatusFilter, persistStatusFilter } from './lib/statusFilterStorage';
import {
  generateProjectScheduleId,
  projectAutomationConfigPath,
  scheduleToProjectConfig,
} from './lib/projectAutomationConfig';
import type { ScheduleFormState } from './lib/scheduleFormLogic';
import {
  buildUsageLimitScheduleFormOverrides,
  readUsageLimitScheduleCreateIntent,
} from './lib/usageLimitScheduleCreateIntent';
import {
  buildPluginScheduleFormOverrides,
  readPluginScheduleCreateIntent,
} from './lib/pluginScheduleCreateIntent';

function scheduleToUserCreateInput(
  schedule: Schedule,
  overrides: Partial<CreateScheduleInput> = {},
): CreateScheduleInput {
  return {
    name: schedule.name,
    prompt: schedule.prompt,
    kind: schedule.kind,
    cronExpr: schedule.cronExpr,
    timezone: schedule.timezone,
    recurring: schedule.recurring,
    manual: schedule.manual,
    intervalMs: schedule.intervalMs,
    agentKind: schedule.agentKind,
    model: schedule.model,
    effort: schedule.effort,
    workspaceKind: schedule.workspaceKind,
    workingDir: schedule.workingDir,
    useWorktree: schedule.useWorktree,
    persistentSession: schedule.persistentSession,
    notify: schedule.notify,
    ...overrides,
  };
}

/**
 * 排序：active 与 expired 同 rank（一次性已跑完的任务不再单独沉底，
 * 跟 active 一起按 lastFiredAt 混排，cell 自身的 "Once" tag 区分一次性任务），
 * paused 沉底；组内按 lastFiredAt desc，没跑过的落本组末尾，最后 updatedAt desc 稳定排序。
 *
 * filter 维度：'active' 桶现在 = active + expired，'paused' = paused，'all' = 全部。
 */
const STATUS_RANK: Record<Schedule['status'], number> = {
  active: 0,
  expired: 0,
  paused: 1,
};

function sortByStatusThenLastRun(list: Schedule[]): Schedule[] {
  return [...list].sort((a, b) => {
    const r = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (r !== 0) return r;
    const aT = a.lastFiredAt ?? 0;
    const bT = b.lastFiredAt ?? 0;
    if (aT !== bT) return bT - aT;
    return b.updatedAt - a.updatedAt;
  });
}

export function getFocusedScheduleStatusFilter(
  schedules: readonly Pick<Schedule, 'id' | 'status'>[],
  focusId: string | null,
): StatusFilter | null {
  if (!focusId) return null;
  const focused = schedules.find((schedule) => schedule.id === focusId);
  if (!focused) return null;
  return focused.status === 'paused' ? 'paused' : 'active';
}

export function SchedulerPage() {
  const { t } = useTranslation();
  // useSchedules 内部还会在 'fired'/'completed' 事件下维护 runningById，
  // 但 master-detail 改版后 running 视觉表达全在 right-pane 的 history card 上
  // （首张 run 自带 Running chip + 脉冲点），左侧 cell 不再叠加 running 态指示，所以这里不解构。
  const { schedules, runtimeSnapshot, loading, error, refresh } = useSchedules();
  const { confirm, confirmThree } = useConfirmDialog();
  const { requestDeleteSchedule, deleteScheduleDialog } = useDeleteScheduleWithSessions({
    onDeleted: () => refresh(),
  });
  const location = useLocation();
  const navigate = useNavigate();

  // 跨 pane 共享的 runNow「派发窗口」busy 守卫：TaskListCell(行按钮) 与 RunHistoryPane
  // (detail 按钮)共用同一份,防止同一 schedule 在派发窗口内被双发。守卫只覆盖"点击 →
  // run 真正 fire"这段派发窗口,不覆盖整个 run 时长(详见 useRunNowBusyGuard)。
  const {
    busyIds: runNowBusyIds,
    begin: beginRunNowBusy,
    release: releaseRunNowBusy,
  } = useRunNowBusyGuard();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [createInitialTemplate, setCreateInitialTemplate] = useState<ScheduleTemplate | null>(null);
  const [createInitialValues, setCreateInitialValues] =
    useState<Partial<ScheduleFormState> | null>(null);
  // 项目分组"+"按钮的预填 workingDir：用户级 schedule，仅省去选项目目录这一步，
  // 不强制写 schedules.json（要"提升为项目自动化"走右键菜单 promoteToProject）。
  const [createPrefillWorkingDir, setCreatePrefillWorkingDir] = useState<string | null>(null);
  // 本次创建面板是由哪个插件请求打开的(agent 槽 schedule 加档)。只做面板上的
  // 来源标注 —— 让用户看清是谁请求建这条任务;不落库(见 pluginScheduleCreateIntent
  // 里 ghostId 的注释:落库要新增 DB 列 + 不可回退的 migration)。
  const [pluginScheduleOrigin, setPluginScheduleOrigin] = useState<{
    ghostId: string;
    ghostName: string;
  } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Status 筛选默认 'all'(默认展示全部任务,含 paused);用户在 popover 主动
  // 切换后持久化,重进页面恢复上次选择(issue #75)。
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(loadStatusFilter);
  // 创建一个新 automation 后想自动选中它，但 selection useEffect 会在 sorted 还没
  // 包含新 id 的那一帧把 selectedId 重置成 sorted[0]。用 ref 暂存 pending id，
  // 等下一轮 sorted 刷新到含有该 id 时再 set，避免被覆盖。
  const pendingSelectIdRef = useRef<string | null>(null);
  const statusSyncedFocusIdRef = useRef<string | null>(null);
  const handledEditTokenRef = useRef<string | null>(null);
  const handledScheduleCreateRequestRef = useRef<string | null>(null);

  // 左侧任务列表 pane 拖拽 resize（与主侧边栏同套机制 → useHorizontalResize）
  // 默认 300，min 240（保证 cell 标题不太早被截），max 480（与主侧边栏对齐）
  const {
    width: taskListWidth,
    isDragging: isResizing,
    handleDragStart: handlePaneResizeStart,
    resetWidth: handlePaneResizeReset,
  } = useHorizontalResize({
    storageKey: 'scheduler.taskListPaneWidth',
    defaultWidth: 300,
    minWidth: 240,
    maxWidth: 480,
  });

  // URL filter：?workingDir=<dir> 只显示该 dir 下 schedule；?focus=<id> 默认选中
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const filterWorkingDir = params.get('workingDir');
  const focusId = params.get('focus');
  const editToken = params.get('edit');

  useEffect(() => {
    if (!focusId) {
      statusSyncedFocusIdRef.current = null;
      return;
    }
    if (statusSyncedFocusIdRef.current === focusId) return;
    const focusedStatusFilter = getFocusedScheduleStatusFilter(schedules, focusId);
    if (!focusedStatusFilter) return;
    statusSyncedFocusIdRef.current = focusId;
    // 只在当前 filter 确实会隐藏目标任务时才切换——'all' 已显示全部任务,
    // 无需覆盖新用户的默认视图 (Codex P2)。
    if (statusFilter === 'all' || statusFilter === focusedStatusFilter) return;
    setStatusFilter(focusedStatusFilter);
  }, [focusId, schedules, statusFilter]);

  useEffect(() => {
    if (!focusId || !editToken) {
      handledEditTokenRef.current = null;
      return;
    }
    if (handledEditTokenRef.current === editToken) return;
    const focused = schedules.find((schedule) => schedule.id === focusId);
    if (!focused) return;
    handledEditTokenRef.current = editToken;
    setCreatePrefillWorkingDir(null);
    setCreateInitialTemplate(null);
    setCreateInitialValues(null);
    setPluginScheduleOrigin(null);
    setEditing(focused);
    setFormOpen(true);
  }, [editToken, focusId, schedules]);

  useEffect(() => {
    const intent = readUsageLimitScheduleCreateIntent(location.state);
    if (!intent || handledScheduleCreateRequestRef.current === intent.requestId) return;
    handledScheduleCreateRequestRef.current = intent.requestId;
    setCreatePrefillWorkingDir(null);
    setCreateInitialTemplate(null);
    setEditing(null);
    setCreateInitialValues(
      buildUsageLimitScheduleFormOverrides(intent, {
        name: t('scheduler.usageLimitRecovery.name'),
        prompt: t('scheduler.usageLimitRecovery.prompt'),
      }),
    );
    setFormOpen(true);
    // Consume the one-shot navigation intent so revisiting Automations does not
    // reopen the modal. Creation still happens only after the user submits.
    const path = `${location.pathname || '/cc-agent/scheduled'}${location.search}`;
    navigate(path, { replace: true, state: null });
  }, [location.pathname, location.search, location.state, navigate, t]);

  // 插件请求新建自动化(agent 槽 schedule 加档):形态与上面 usage-limit 那条
  // 完全一致 —— 一次性导航意图 → 预填打开面板 → 用完立刻清掉 state。
  // 与它共用 handledScheduleCreateRequestRef:两种意图不该叠开两个面板。
  // ⚠️ 这里只 setCreateInitialValues + 打开面板,**不创建任务**。落库仍然只发生在
  // 用户点保存后走 handleSubmit —— 插件全程没有直接建任务的通道。
  useEffect(() => {
    const intent = readPluginScheduleCreateIntent(location.state);
    if (!intent || handledScheduleCreateRequestRef.current === intent.requestId) return;
    handledScheduleCreateRequestRef.current = intent.requestId;
    const consumeState = () => {
      const path = `${location.pathname || '/cc-agent/scheduled'}${location.search}`;
      navigate(path, { replace: true, state: null });
    };
    // 表单已经开着 → **不覆盖**,提示后把这次请求丢掉(review #1715 的 Codex P2)。
    // ⚠️ PR 号写成 `review` 紧跟编号的语序不是随手排版:scheduler-ci-guard 的
    // 色值白名单规则会把「井号 + 4 位数字」当成 RGBA 简写色值,它只豁免紧跟
    // `PR ` / `review ` 的写法(见 scripts/scheduler-ci-guard.mjs)。
    //
    // 为什么不能直接往下走:ScheduleFormDialog 的 reset effect 依赖 initialValues 且
    // 守卫只有 `if (!open) return`(components/ScheduleFormDialog.tsx 的那个 effect),
    // 所以在表单已 open 时换一份 initialValues 会**静默 reset 掉用户正在填的内容**。
    // 插件请求可以在任何时刻到达,这条路径是本 PR 打开的,必须由本 PR 兜住。
    //
    // 语义选"拒绝 + 提示"而不是"延后"或"弹确认":延后要引入待处理队列与过期判定,
    // 弹确认会在用户填表中途再插一层模态——两者都比"让用户存完再点一次"更重。用户
    // 输入绝不丢是硬要求,一次插件请求丢掉只需再点一次,代价不对称。
    //
    // 只可能在用户正停在自动化页时命中:formOpen 是本页 state,离开页面即卸载归 false。
    if (formOpen) {
      toast.warning(t('scheduler.toast.pluginDraftIgnoredFormOpen', { name: intent.ghostName }));
      consumeState();
      return;
    }
    setCreatePrefillWorkingDir(null);
    setCreateInitialTemplate(null);
    setEditing(null);
    setCreateInitialValues(buildPluginScheduleFormOverrides(intent));
    setPluginScheduleOrigin({ ghostId: intent.ghostId, ghostName: intent.ghostName });
    setFormOpen(true);
    consumeState();
  }, [formOpen, location.pathname, location.search, location.state, navigate, t]);

  // workingDir filter（URL ?workingDir=...）
  const scopedByDir = useMemo(() => {
    if (!filterWorkingDir) return schedules;
    const target = normalizeWorkingDir(filterWorkingDir);
    return schedules.filter((s) => normalizeWorkingDir(s.workingDir ?? null) === target);
  }, [schedules, filterWorkingDir]);

  const filtered = useMemo(() => {
    let list = scopedByDir;
    if (statusFilter === 'active') {
      // 'active' 桶视觉上含 expired —— 一次性已跑完的任务不再单独成桶，
      // 跟正常 active 一起展示，cell 上靠 "Once" tag 区分。
      list = list.filter((s) => s.status === 'active' || s.status === 'expired');
    } else if (statusFilter !== 'all') {
      list = list.filter((s) => s.status === statusFilter);
    }
    return list;
  }, [scopedByDir, statusFilter]);

  const sorted = useMemo(() => sortByStatusThenLastRun(filtered), [filtered]);

  // selectedId 维护：pending(刚创建的) > focus > 已选未失效 > 列表头条 > null
  useEffect(() => {
    if (sorted.length === 0) {
      setSelectedId(null);
      return;
    }
    const pending = pendingSelectIdRef.current;
    if (pending && sorted.some((s) => s.id === pending)) {
      pendingSelectIdRef.current = null;
      setSelectedId(pending);
      return;
    }
    if (focusId && sorted.some((s) => s.id === focusId)) {
      setSelectedId(focusId);
      return;
    }
    setSelectedId((prev) => {
      if (prev && sorted.some((s) => s.id === prev)) return prev;
      return sorted[0].id;
    });
  }, [sorted, focusId]);

  const selected = useMemo(
    () => sorted.find((s) => s.id === selectedId) ?? null,
    [sorted, selectedId],
  );
  const unreadRunCounts = useScheduleUnreadRunCounts(sorted);
  const { summaries: costSummaries, loaded: costSummariesLoaded } =
    useScheduleCostSummaries(sorted);

  // 仅用户在 TaskListFilterPopover 主动切换时持久化;focus 同步 / 新建任务的
  // 程序性 setStatusFilter 不写入,避免覆盖用户偏好(详见 statusFilterStorage)。
  const handleStatusFilterChange = useCallback((v: StatusFilter) => {
    setStatusFilter(v);
    persistStatusFilter(v);
  }, []);

  const handleCreate = useCallback(() => {
    setCreatePrefillWorkingDir(null);
    setCreateInitialTemplate(null);
    setCreateInitialValues(null);
    setPluginScheduleOrigin(null);
    setEditing(null);
    setFormOpen(true);
  }, []);

  const handleCreateFromTemplate = useCallback((template: ScheduleTemplate) => {
    setCreatePrefillWorkingDir(null);
    setCreateInitialTemplate(template);
    setCreateInitialValues(null);
    setPluginScheduleOrigin(null);
    setEditing(null);
    setFormOpen(true);
  }, []);

  const handleEdit = useCallback((s: Schedule) => {
    setCreatePrefillWorkingDir(null);
    setCreateInitialTemplate(null);
    setCreateInitialValues(null);
    setPluginScheduleOrigin(null);
    setEditing(s);
    setFormOpen(true);
  }, []);

  const handleCreateProjectSchedule = useCallback((workingDir: string) => {
    setEditing(null);
    setCreateInitialTemplate(null);
    setCreateInitialValues(null);
    setPluginScheduleOrigin(null);
    setCreatePrefillWorkingDir(workingDir);
    setFormOpen(true);
  }, []);

  const handleSubmit = useCallback(
    async (input: CreateScheduleInput | UpdateScheduleInput, isEdit: boolean) => {
      if (isEdit && editing) {
        await window.electronAPI.maker.schedule.update(editing.id, input);
        toast.success(t('scheduler.toast.updated'));
      } else {
        const created = (await window.electronAPI.maker.schedule.create(
          input as CreateScheduleInput,
        )) as Schedule;
        toast.success(t('scheduler.toast.created'));
        // 新建的 automation 默认 status='active'，跟默认 statusFilter 一致；
        // 若用户当前在 paused/expired 视图，切回 active 以确保新条目可见。
        if (statusFilter !== 'all' && statusFilter !== 'active') {
          setStatusFilter('active');
        }
        pendingSelectIdRef.current = created.id;
      }
      // 'changed' 事件会触发 useSchedules.refresh；这里再手工兜底一次防丢
      void refresh();
    },
    [editing, refresh, statusFilter, t],
  );

  const handleRunNow = useCallback(
    async (s: Schedule) => {
      // begin 同步门控：已在派发窗口内(begin 返回 false)直接忽略，防止首帧 setState
      // 重渲染前的双击/并发点击。
      if (!beginRunNowBusy(s.id)) return;
      try {
        // 注意：这个 promise 要等 run 跑完才 resolve —— busy 的正常释放走 'fired' 事件
        // (见 useRunNowBusyGuard 内的 onEvent 订阅)，不在这里。
        await window.electronAPI.maker.schedule.runNow(s.id);
      } catch (e) {
        toast.error(
          t('scheduler.toast.runFailed', { error: e instanceof Error ? e.message : String(e) }),
        );
      } finally {
        // 安全网：catch 路径（fire 前抛错，'fired' 不会到达）在此首次 release；正常路径
        // 若 IPC 事件通道偶发丢包导致 'fired'/终态均未到达，release 仍会在 promise settle
        // 后兜底执行。guard 已 release 时本调用为 no-op（幂等）。
        releaseRunNowBusy(s.id);
      }
    },
    [t, beginRunNowBusy, releaseRunNowBusy],
  );

  const handleTogglePause = useCallback(
    async (s: Schedule) => {
      try {
        if (s.status === 'paused') {
          await window.electronAPI.maker.schedule.resume(s.id);
          return;
        }
        // pause 路径:有 in-flight 时弹合并文案确认 —— "暂停将立即停止 N 次正在进行的执行"。
        // 无 in-flight 时跳过 confirm 保持原 UX(用户主动点暂停不需要二次确认)。
        const inflight = await window.electronAPI.maker.schedule
          .getInflightCount(s.id)
          .catch(() => 0);
        if (inflight > 0) {
          const ok = await confirm({
            title: t('scheduler.confirm.pause.title', { name: s.name }),
            description: t('scheduler.confirm.pause.withInflight', { count: inflight }),
            confirmText: t('scheduler.confirm.pause.confirm'),
            cancelText: t('scheduler.confirm.pause.cancel'),
          });
          if (!ok) return;
        }
        await window.electronAPI.maker.schedule.pause(s.id);
      } catch (e) {
        toast.error(
          t('scheduler.toast.actionFailed', { error: e instanceof Error ? e.message : String(e) }),
        );
      }
    },
    [confirm, t],
  );

  // 双击 cell 改名：与 SessionItem 同款 — 走通用的 schedule.update({ name })
  // 引擎 update 后会广播 'changed'，useSchedules 自动刷新，无需手动 refresh。
  const handleRename = useCallback(
    async (s: Schedule, newName: string) => {
      try {
        await window.electronAPI.maker.schedule.update(s.id, { name: newName });
      } catch (e) {
        toast.error(
          t('scheduler.toast.renameFailed', { error: e instanceof Error ? e.message : String(e) }),
        );
      }
    },
    [t],
  );

  const handleOpenProjectConfig = useCallback(
    async (workingDir: string) => {
      const filePath = projectAutomationConfigPath(workingDir);
      try {
        const result = await window.electronAPI.openPath(filePath);
        if (!result.success)
          toast.error(result.error || t('scheduler.list.section.openConfigFailed'));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    },
    [t],
  );

  const handleReloadProject = useCallback(
    async (workingDir: string) => {
      try {
        await window.electronAPI.maker.projectAutomation.reconcile({ workingDir });
        void refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
  );

  const handlePromoteToProject = useCallback(
    async (s: Schedule) => {
      if (!s.workingDir) {
        toast.warning(t('scheduler.list.promote.noWorkingDir'));
        return;
      }
      try {
        await window.electronAPI.maker.projectAutomation.upsertSchedule({
          workingDir: s.workingDir,
          config: scheduleToProjectConfig(s, generateProjectScheduleId()),
        });
        await window.electronAPI.maker.schedule.delete(s.id);
        void refresh();
        toast.success(t('scheduler.list.promote.success'));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh, t],
  );

  const handleEditProjectSchedule = useCallback((s: Schedule) => {
    setCreatePrefillWorkingDir(null);
    setCreateInitialTemplate(null);
    setPluginScheduleOrigin(null);
    setEditing(s);
    setFormOpen(true);
  }, []);

  const handleCloneToUser = useCallback(
    async (s: Schedule) => {
      try {
        await window.electronAPI.maker.schedule.create(
          scheduleToUserCreateInput(s, {
            name: t('scheduler.list.cloneToUser.namePrefix', { name: s.name }),
          }),
        );
        void refresh();
        toast.success(t('scheduler.list.cloneToUser.success'));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh, t],
  );

  const handleRemoveProjectSchedule = useCallback(
    async (s: Schedule) => {
      if (!s.workingDir || !s.projectConfigId) return;
      const result = await confirmThree({
        title: t('scheduler.list.removeProject.confirmTitle'),
        description: t('scheduler.list.removeProject.confirmDescription', { name: s.name }),
        confirmText: t('scheduler.list.removeProject.confirm'),
        tertiaryText: t('scheduler.list.removeProject.demote'),
        cancelText: t('scheduler.confirm.delete.cancel'),
      });
      if (result === 'cancel') return;
      try {
        if (result === 'tertiary') {
          await window.electronAPI.maker.schedule.create(scheduleToUserCreateInput(s));
        }
        await window.electronAPI.maker.projectAutomation.removeSchedule({
          workingDir: s.workingDir,
          id: s.projectConfigId,
        });
        void refresh();
        if (result === 'tertiary') {
          toast.success(t('scheduler.list.removeProject.demoteSuccess'));
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    },
    [confirmThree, refresh, t],
  );

  const handleDelete = useCallback(
    (s: Schedule) => {
      requestDeleteSchedule({
        id: s.id,
        name: s.name,
        source: s.source,
        workingDir: s.workingDir ?? undefined,
        projectConfigId: s.projectConfigId ?? undefined,
      });
    },
    [requestDeleteSchedule],
  );

  // EmptyState 只在「整库没有任务」时显示，避免 workingDir / status
  // 等用户主动筛选导致的空列表误触发 onboard CTA。
  const isEmpty = !loading && !error && schedules.length === 0;

  return (
    <div className="flex h-full w-full flex-col bg-[hsl(var(--content-area))]">
      {/* Header — 无 loading 守卫（CLAUDE.md §12：避免 loading→loaded 那一帧
          count / New 按钮突然出现导致整行抖动）。空数据时 New 按钮藏起来留给 EmptyState
          的主 CTA 接盘，避免双 CTA。 */}
      <header
        className="flex min-h-[68px] shrink-0 items-center justify-between gap-4 border-b border-[var(--cmd-palette-border)] px-6 py-4"
        // mac 上本页不渲染通用 ContentHeader,页头自身承担窗口拖拽（windowDrag.tsx 约定）
        style={WINDOW_DRAG_STYLE}
      >
        <div className="flex min-w-0 items-center gap-3">
          <Timer
            size={18}
            strokeWidth={1.75}
            className="shrink-0 text-[var(--settings-section-desc)]"
          />
          <div className="flex items-baseline gap-2.5">
            <h1 className="text-lg font-medium leading-none text-[var(--msg-assistant-text)]">
              {t('scheduler.page.title')}
            </h1>
            <span className="text-xs leading-none text-[var(--cmd-palette-item-meta)]">
              {filterWorkingDir
                ? t('scheduler.page.totalCountWithDir', {
                    dir: filterWorkingDir,
                    count: sorted.length,
                  })
                : t('scheduler.page.totalCount', { count: sorted.length })}
            </span>
          </div>
        </div>
        {/* 空数据时 New 按钮藏起来，留给 EmptyState 的主 CTA 接盘，避免双 CTA。 */}
        {!error && !isEmpty && (
          <div style={WINDOW_NO_DRAG_STYLE}>
            <NewAutomationButton onClick={handleCreate} />
          </div>
        )}
      </header>

      {/* Body — 无 loading 态显示（CLAUDE.md §12：本地数据走完异步取数再刷界面，
          loading 期间不显示任何 placeholder，避免视觉上的空白帧/跳变）。 */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {error && (
          <p className="px-6 py-5 text-sm text-[var(--cmd-palette-item-meta)]">
            {t('scheduler.page.loadFailed', { error })}
          </p>
        )}
        {isEmpty && (
          <EmptyState onCreate={handleCreate} onCreateFromTemplate={handleCreateFromTemplate} />
        )}
        {!error && !isEmpty && (
          // 拖拽中给整行加 select-none + col-resize cursor，避免误选中文字、
          // 鼠标越过 RunHistoryPane 时 cursor 跳变（与 MainLayout 包住 sidebar 的处理一致）。
          <div className={cn('flex h-full', isResizing && 'cursor-col-resize select-none')}>
            <TaskListPane
              schedules={sorted}
              selectedId={selectedId}
              unreadRunCounts={unreadRunCounts}
              costSummaries={costSummaries}
              costSummariesLoaded={costSummariesLoaded}
              onSelect={(s) => setSelectedId(s.id)}
              statusFilter={statusFilter}
              onStatusFilterChange={handleStatusFilterChange}
              onTogglePause={handleTogglePause}
              onDelete={handleDelete}
              onRename={handleRename}
              onOpenProjectConfig={handleOpenProjectConfig}
              onReloadProject={handleReloadProject}
              onCreateProjectSchedule={handleCreateProjectSchedule}
              onPromoteToProject={handlePromoteToProject}
              onEditProjectSchedule={handleEditProjectSchedule}
              onCloneToUser={handleCloneToUser}
              onRemoveProjectSchedule={handleRemoveProjectSchedule}
              onRunNow={handleRunNow}
              runNowBusyIds={runNowBusyIds}
              runtimeSnapshot={runtimeSnapshot}
              width={taskListWidth}
              onResizeStart={handlePaneResizeStart}
              onResizeReset={handlePaneResizeReset}
            />
            {selected && (
              <RunHistoryPane
                schedule={selected}
                onRunNow={handleRunNow}
                onTogglePause={handleTogglePause}
                onEdit={handleEdit}
                onDelete={handleDelete}
                runNowBusy={runNowBusyIds.has(selected.id)}
              />
            )}
          </div>
        )}
      </div>

      <ScheduleFormDialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) {
            setCreatePrefillWorkingDir(null);
            setCreateInitialTemplate(null);
            setCreateInitialValues(null);
            setPluginScheduleOrigin(null);
          }
        }}
        initial={editing}
        initialTemplate={createInitialTemplate}
        initialValues={createInitialValues}
        initialWorkingDir={createPrefillWorkingDir}
        requestedByGhostName={pluginScheduleOrigin?.ghostName ?? null}
        editProjectSchedule={editing?.source === 'project'}
        onSubmit={handleSubmit}
      />
      {deleteScheduleDialog}
    </div>
  );
}

/** 主 CTA pill 按钮：避开纯黑纯白（feedback_no_pure_black_white），用 #262626 / #d4d4d4。
 */
function NewAutomationButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-9 items-center gap-1.5 rounded-full px-5 text-sm font-medium',
        'bg-[var(--lightbox-cta-bg)] text-[var(--lightbox-cta-fg)] hover:bg-[var(--lightbox-cta-hover)]',
        'transition-colors',
        '[&>svg]:-translate-y-px',
      )}
    >
      <Plus size={14} strokeWidth={2.5} />
      {t('scheduler.button.newAutomation')}
    </button>
  );
}

function EmptyState({
  onCreate,
  onCreateFromTemplate,
}: {
  onCreate: () => void;
  onCreateFromTemplate: (template: ScheduleTemplate) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full w-full flex-col overflow-y-auto px-8 pt-12 pb-8 [scrollbar-gutter:stable_both-edges]">
      <div className="mx-auto flex w-full max-w-[800px] flex-col gap-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--chat-input-chip-bg)]">
            <Timer size={28} strokeWidth={1.5} className="text-[var(--cmd-palette-item-meta)]" />
          </div>
          <h2 className="text-lg font-medium text-[var(--msg-assistant-text)]">
            {t('scheduler.empty.promptHeading')}
          </h2>
          <p className="max-w-md text-sm text-[var(--cmd-palette-item-meta)]">
            {t('scheduler.empty.promptDescription')}
          </p>
          <NewAutomationButton onClick={onCreate} />
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-[var(--cmd-palette-item-meta)]">
            {t('scheduler.template.gallery.heading')}
          </h3>
          <TemplateGallery onSelect={onCreateFromTemplate} />
        </div>
      </div>
    </div>
  );
}
