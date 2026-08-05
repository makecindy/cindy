/**
 * BackgroundTasksBody —— 「后台任务」tab 的内容区。
 *
 * 两个视图:
 *  - 列表:Running / Completed 两分区(排序由 listSessionTasks 保证:running 按
 *    启动升序、completed 按完成倒序),行 = kind 图标 + 状态图标 + 标题 + meta
 *    (状态 · 时长 · tokens · 工具调用),running 的 claude-code 任务行尾给 Stop。
 *  - workflow 详情:返回按钮 + 头部(标题 + Stop)+ WorkflowProgressTree 逐 agent
 *    进度树。
 *
 * 数据约束:
 *  - 事件源:makerChatStore 按 sessionId 订阅,快照 getter 只挑
 *    messages / taskUpdates / isStreaming 三个引用比对缓存 —— 不走
 *    useCCAgentChat 的重快照路径,其他字段(流式文本等)高频变更不触发重渲。
 *  - 面板不可见(非激活 tab / 壳子隐藏)时订阅挂空,恢复可见时重订阅自动补读。
 *  - 快照水合:挂载时对本机会话调一次 listSessionBackgroundTasks 经
 *    seedBackgroundTaskSnapshots 补存量(与 useBackgroundBashTasks 同口径,只复用
 *    store 公开函数);device-link 远程会话跳过(main 拿不到 handle,快照必空)。
 *  - wf 文件辅源:详情视图挂载时拉一次 getWorkflowProgressFor,任务从 running 翻
 *    终态时再拉一次;不轮询。远程/老被控端自动降级返回 null。
 *  - 停止:gating = running + claude-code + 有 taskId + 非远程会话;在飞防连点、
 *    失败静默,终态交给 task_notification 事件流收口(同 AgentTaskCard 口径)。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  CircleDashed,
  CircleStop,
  ListTodo,
  LoaderCircle,
  Square,
  SquareTerminal,
  Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { isSidebarWindow } from '@/lib/sidebarWindow';
import {
  getSessionDeviceId,
  useRemoteDevices,
} from '@/features/device-link/remoteProjectsStore';
import { makerChatStore, EMPTY_TASK_UPDATES } from '@/lib/makerChatStore';
import type { AgentTaskUpdate, ChatMessage } from '@/lib/makerChatStore';
import {
  getWorkflowProgressFor,
  isRemoteSessionSticky,
  listSessionBackgroundTasksFor,
} from '@/lib/makerTransport';
import { formatCompactTokens } from '@/lib/usageFormat';
import type { Message } from '@/lib/ccAgent.types';
import type { WorkflowProgress } from '../../../../../shared/workflow-progress';
import type { TabKindHostContext } from '../../types';
import type { BackgroundTasksState } from './index';
import { listSessionTasks, type SessionTaskItem } from './listSessionTasks';
import {
  buildWorkflowTreeModel,
  fileStatusToTaskStatus,
  isTerminalWorkflowFileStatus,
  workflowAgentVisualState,
} from './workflowProgressModel';
import { WorkflowProgressTree } from './WorkflowProgressTree';
import { requestChatTaskFocus } from './chatTaskFocusIntent';

// ---------------------------------------------------------------------------
// store 订阅(轻量选择器)
// ---------------------------------------------------------------------------

interface SessionTaskInputs {
  messages: ChatMessage[];
  taskUpdates: ReadonlyMap<string, AgentTaskUpdate>;
  isStreaming: boolean;
}

const EMPTY_MESSAGES: ChatMessage[] = [];
/** 无 sessionId 时的稳定空快照(useSyncExternalStore 要求引用稳定)。 */
const EMPTY_INPUTS: SessionTaskInputs = {
  messages: EMPTY_MESSAGES,
  taskUpdates: EMPTY_TASK_UPDATES,
  isStreaming: false,
};

/**
 * 订阅当前会话的 (messages, taskUpdates, isStreaming) 三元组。
 * paused=true(面板不可见)时订阅挂空 —— 不再接收通知;恢复时 subscribe 引用
 * 变化触发 React 重订阅并重读快照,数据自动追平,无需额外刷新逻辑。
 */
function useSessionTaskInputs(sessionId: string | null, paused: boolean): SessionTaskInputs {
  const cacheRef = useRef<{
    messages: ChatMessage[];
    taskUpdates: ReadonlyMap<string, AgentTaskUpdate>;
    isStreaming: boolean;
    snapshot: SessionTaskInputs;
  } | null>(null);

  const subscribeStore = useCallback(
    (cb: () => void) => {
      if (!sessionId || paused) return () => {};
      return makerChatStore.subscribe(sessionId, cb);
    },
    [sessionId, paused],
  );

  const getInputs = useCallback((): SessionTaskInputs => {
    if (!sessionId) return EMPTY_INPUTS;
    const s = makerChatStore.getSnapshot(sessionId);
    const cached = cacheRef.current;
    // 三个引用全等 → 返回缓存快照,React Object.is 短路,避免无关字段变更引发重渲。
    if (
      cached &&
      cached.messages === s.messages &&
      cached.taskUpdates === s.taskUpdates &&
      cached.isStreaming === s.isStreaming
    ) {
      return cached.snapshot;
    }
    const snapshot: SessionTaskInputs = {
      messages: s.messages,
      // taskUpdates 类型上可缺省(历史快照形态),缺省回落稳定空 Map。
      taskUpdates: s.taskUpdates ?? EMPTY_TASK_UPDATES,
      isStreaming: s.isStreaming,
    };
    cacheRef.current = { ...snapshot, snapshot };
    return snapshot;
  }, [sessionId]);

  return useSyncExternalStore(subscribeStore, getInputs);
}

// ---------------------------------------------------------------------------
// 展示辅助
// ---------------------------------------------------------------------------

/** kind → 行首图标(与聊天卡片的视觉词汇一致)。 */
function kindIcon(kind: SessionTaskItem['kind']): LucideIcon {
  if (kind === 'workflow') return Workflow;
  if (kind === 'bash') return SquareTerminal;
  if (kind === 'agent') return Bot;
  return CircleDashed;
}

/** 标题兜底(listSessionTasks 契约:取不到来源时 title='',由 UI 补 i18n 文案)。 */
function fallbackTitleKey(kind: SessionTaskItem['kind']): string {
  if (kind === 'workflow') return 'chat.agentTask.provider.workflow';
  if (kind === 'bash') return 'chat.agentTask.provider.shell';
  return 'chat.agentTask.emptyTitle';
}

/** status → 状态图标(running 由 Spinner 负责旋转)。 */
function statusIcon(status: string): LucideIcon {
  if (status === 'completed') return CheckCircle2;
  if (status === 'failed') return AlertCircle;
  if (status === 'stopped') return CircleStop;
  return LoaderCircle;
}

/** 毫秒 → 紧凑时长文案(与 AgentTaskCard 同口径;该实现未导出,此处内联)。 */
function formatDuration(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/** workflow 行副标题:workflow_agent 条目 done/error 计数 / 总数。 */
function workflowAgentCounts(
  update: AgentTaskUpdate | undefined,
): { done: number; total: number } | null {
  const entries = update?.workflowProgress;
  if (!entries || entries.length === 0) return null;
  let total = 0;
  let done = 0;
  for (const entry of entries) {
    if (entry.type !== 'workflow_agent') continue;
    total += 1;
    // 收口判定走 workflowAgentVisualState 归一(与方块条同一词表源,
    // done/completed 与 error/failed/stopped/killed 全算已收口)。
    const visual = workflowAgentVisualState(entry.state);
    if (visual === 'done' || visual === 'failed') done += 1;
  }
  return total > 0 ? { done, total } : null;
}

/** 停止按钮 gating(与 AgentTaskCard 同口径):running + claude-code + 有 taskId +
 *  非远程。远程判定用粘滞版:relay 瞬断窗口误判本机会放出假 Stop(本地调用假成功,
 *  任务在被控端继续跑),与水合的粘滞归属同口径。 */
function canStopItem(item: SessionTaskItem, sessionId: string | null): boolean {
  return (
    item.status === 'running' &&
    item.provider === 'claude-code' &&
    Boolean(item.update?.taskId) &&
    Boolean(sessionId) &&
    !(sessionId && isRemoteSessionSticky(sessionId))
  );
}

/** 停止按钮:在飞防连点、失败静默,状态翻转由事件流收口(不改本地状态)。 */
function StopButton({ sessionId, taskId }: { sessionId: string; taskId: string }) {
  const { t } = useTranslation();
  const [stopping, setStopping] = useState(false);
  const handleStop = useCallback(
    (e: MouseEvent) => {
      // 行点击(进详情 / 聊天定位)不该被停止按钮触发。
      e.stopPropagation();
      const api = window.electronAPI?.maker;
      if (!api?.stopAgentTask || stopping) return;
      setStopping(true);
      void api
        .stopAgentTask(sessionId, taskId)
        .catch(() => {
          // 静默:真失败时状态仍是 running,按钮保留可重试。
        })
        .finally(() => setStopping(false));
    },
    [sessionId, taskId, stopping],
  );
  return (
    <button
      type="button"
      onClick={handleStop}
      disabled={stopping}
      aria-label={t('rightSidebar.backgroundTasks.stop')}
      title={t('rightSidebar.backgroundTasks.stop')}
      className={cn(
        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
        stopping && 'cursor-default opacity-50',
      )}
    >
      <Square size={12} aria-hidden="true" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// 列表行
// ---------------------------------------------------------------------------

function TaskRow({
  item,
  sessionId,
  onOpenWorkflow,
}: {
  item: SessionTaskItem;
  sessionId: string | null;
  onOpenWorkflow: (key: string) => void;
}) {
  const { t } = useTranslation();
  const KindIcon = kindIcon(item.kind);
  const StatusIcon = statusIcon(item.status);
  const running = item.status === 'running';

  // meta:状态 · 时长 · tokens · 工具调用(缺项省略);workflow 行前置 agent 进度摘要。
  const metaParts = useMemo(() => {
    const parts: string[] = [];
    const knownStatus =
      item.status === 'running' ||
      item.status === 'completed' ||
      item.status === 'failed' ||
      item.status === 'stopped';
    if (knownStatus) parts.push(t(`chat.agentTask.status.${item.status}`));
    if (item.kind === 'workflow') {
      const counts = workflowAgentCounts(item.update);
      if (counts) {
        parts.push(
          t('rightSidebar.backgroundTasks.progressSummary', {
            done: counts.done,
            total: counts.total,
          }),
        );
      }
    }
    const usage = item.update?.usage;
    const duration = formatDuration(usage?.durationMs);
    if (duration) parts.push(duration);
    if (typeof usage?.totalTokens === 'number') {
      parts.push(
        t('rightSidebar.backgroundTasks.tokens', {
          value: formatCompactTokens(usage.totalTokens),
        }),
      );
    }
    if (typeof usage?.toolUses === 'number') {
      parts.push(t('chat.agentTask.toolUses', { count: usage.toolUses }));
    }
    return parts;
  }, [item, t]);

  // 非 workflow 行的聊天定位:意图 emitter 是 renderer 进程内的,独立侧栏窗口里
  // 没有聊天流也没有跨窗口中转 —— 点了必然无响应,不给假 affordance(跨窗口
  // 转发作为后续跟进)。workflow 行(面板内详情)两种宿主都可点。
  const clickable =
    item.kind === 'workflow' ||
    (Boolean(sessionId) && Boolean(item.toolCallClientId) && !isSidebarWindow());
  const handleClick = useCallback(() => {
    if (item.kind === 'workflow') {
      onOpenWorkflow(item.key);
      return;
    }
    if (sessionId && item.toolCallClientId) {
      requestChatTaskFocus(sessionId, item.toolCallClientId);
    }
  }, [item, sessionId, onOpenWorkflow]);

  return (
    <div className="flex items-start gap-1">
      <button
        type="button"
        onClick={clickable ? handleClick : undefined}
        className={cn(
          'flex min-w-0 flex-1 items-start gap-2 rounded-[8px] px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
          clickable ? 'hover:bg-[var(--surface-hover)]' : 'cursor-default',
        )}
      >
        <span className="mt-[1px] inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-secondary)]">
          <KindIcon size={12} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <Spinner
              icon={StatusIcon}
              size={13}
              spinning={running}
              className={cn(
                'shrink-0 text-[var(--text-secondary)]',
                item.status === 'failed' && 'text-[var(--error-fg)]',
              )}
            />
            <span className="truncate text-13 leading-5 text-[var(--text-primary)]">
              {item.title || t(fallbackTitleKey(item.kind))}
            </span>
          </span>
          {metaParts.length > 0 && (
            <span className="mt-0.5 block truncate text-11 leading-4 text-[var(--text-tertiary)]">
              {metaParts.join(' · ')}
            </span>
          )}
        </span>
      </button>
      {canStopItem(item, sessionId) && sessionId && item.update?.taskId && (
        <div className="pt-1.5">
          <StopButton sessionId={sessionId} taskId={item.update.taskId} />
        </div>
      )}
    </div>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="px-2 pb-1 pt-3 text-11 font-medium uppercase tracking-[0.5px] text-[var(--text-tertiary)]">
      {label}
    </div>
  );
}

// ---------------------------------------------------------------------------
// workflow 详情
// ---------------------------------------------------------------------------

function WorkflowDetail({
  item,
  sessionId,
  onBack,
}: {
  item: SessionTaskItem;
  sessionId: string | null;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const taskId = item.update?.taskId ?? item.taskId ?? null;
  const [fileProgress, setFileProgress] = useState<WorkflowProgress | null>(null);

  // wf 文件辅源:挂载读一次;任务翻终态(isTerminal false→true 触发 effect 重跑)
  // 再读一次。任务已终态而文件快照还停在运行中(终态事件先于终局落盘)时做有界
  // 重试(至多 2 次,1.5s 间隔),文件收口即停 —— 仍不是轮询。远程会话/老被控端
  // getWorkflowProgressFor 内部降级 null,读不到时详情树退化为事件流数据。
  // deviceConnectivity 参与依赖(与列表水合同款):断连窗口内打开的详情读到
  // null 后,重连翻转触发重读,不必退出重进;本机会话恒 'local'。
  const isTerminal = item.status !== 'running';
  const remoteDevices = useRemoteDevices();
  const detailDeviceId = sessionId ? getSessionDeviceId(sessionId) : undefined;
  const deviceConnectivity = detailDeviceId
    ? `${detailDeviceId}:${
        remoteDevices.find((d) => d.deviceId === detailDeviceId)?.connected ? '1' : '0'
      }`
    : 'local';
  useEffect(() => {
    if (!sessionId || !taskId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = (retriesLeft: number) => {
      void getWorkflowProgressFor(sessionId, taskId)
        .then((progress) => {
          if (disposed) return;
          if (progress) setFileProgress(progress);
          const settled = isTerminalWorkflowFileStatus(progress?.status);
          if (isTerminal && !settled && retriesLeft > 0) {
            timer = setTimeout(() => read(retriesLeft - 1), 1500);
          }
        })
        .catch(() => {
          // 静默:文件辅源缺失时详情树退化为事件流数据。
        });
    };
    read(isTerminal ? 2 : 0);
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [sessionId, taskId, isTerminal, deviceConnectivity]);

  const model = useMemo(
    () =>
      buildWorkflowTreeModel({
        entries: item.update?.workflowProgress,
        fileProgress,
        taskStatus: item.status,
        usage: item.update?.usage,
      }),
    [item.update?.workflowProgress, fileProgress, item.status, item.update?.usage],
  );

  const title = item.update?.workflowName ?? (item.title || t(fallbackTitleKey(item.kind)));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border-default)] px-2 py-1.5">
        <button
          type="button"
          onClick={onBack}
          aria-label={t('rightSidebar.backgroundTasks.back')}
          title={t('rightSidebar.backgroundTasks.back')}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
        >
          <ArrowLeft size={14} aria-hidden="true" />
        </button>
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-secondary)]">
          <Workflow size={12} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1 truncate text-13 font-medium leading-5 text-[var(--text-primary)]">
          {title}
        </span>
        {canStopItem(item, sessionId) && sessionId && item.update?.taskId && (
          <StopButton sessionId={sessionId} taskId={item.update.taskId} />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {model ? (
          <WorkflowProgressTree model={model} />
        ) : item.update?.summary || item.resultPreview ? (
          // 降级兜底:事件树与 wf 文件都拿不到(老被控端 / SSH / 未落盘即退出)时,
          // 展示 workflow 的结果文本 —— 面板是主视图,点开不能只剩一句「暂无进度」。
          <div className="whitespace-pre-wrap break-words px-2 py-1 text-12 leading-5 text-[var(--text-secondary)]">
            {item.update?.summary ?? item.resultPreview}
          </div>
        ) : (
          <div className="px-2 py-6 text-center text-12 text-[var(--text-tertiary)]">
            {t('rightSidebar.backgroundTasks.noProgress')}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TabBody
// ---------------------------------------------------------------------------

export function BackgroundTasksBody({
  state,
  ctx,
  active,
  shellVisible,
}: {
  state: BackgroundTasksState;
  ctx: TabKindHostContext;
  active?: boolean;
  shellVisible?: boolean;
}) {
  const { t } = useTranslation();
  const sessionId = ctx.sessionId || null;
  // 不可见(非激活 tab / 壳子隐藏)时暂停 store 订阅;active/shellVisible 缺省视为可见。
  const visible = (active ?? true) && (shellVisible ?? true);

  const inputs = useSessionTaskInputs(sessionId, !visible);

  // 消息水合:独立侧栏窗口(SidebarWindowLayout)里没有会话视图替本面板调
  // ensureInitialMessages,store 的 messages 恒空 → 历史扫描源(Completed 区)
  // 整段缺失。该函数幂等(historyLoaded / in-flight 双守卫),主窗口场景是 no-op。
  useEffect(() => {
    if (!sessionId) return;
    const dispose = visible ? makerChatStore.enterView(sessionId) : undefined;
    makerChatStore.ensureInitialMessages(sessionId);
    return dispose;
  }, [sessionId, visible]);

  // 快照水合:挂载 / 切会话时拉一次存量后台任务(订阅前已启动 / 重载清空
  // taskUpdates 后事件流看不到的任务)。listSessionBackgroundTasksFor 按会话来源
  // 路由 —— 本机走本地 IPC,device-link 远程隧道到被控端(任务真身在被控端,
  // 本机快照必空);老被控端无此 channel 时内部降级空表。失败静默,实时事件流
  // 自然补上(与 useBackgroundBashTasks 的快照失败同口径)。
  // taskUpdatesEmpty 参与依赖:reloadMessages(rewind / 远程 origin 对账)会在
  // 面板已挂载时清空 taskUpdates,布尔翻 true 即自动重水合;翻回 false 的那次
  // 重跑只是多一次幂等快照(seed 仅补缺),不会循环。
  const taskUpdatesEmpty = inputs.taskUpdates.size === 0;
  // deviceConnectivity 参与依赖:面板挂载时被控设备恰好瞬断的话,隧道失败被
  // 降级成空表且此后无人重试。注意 markDeviceDisconnected 型瞬断(presence
  // offline / relay connecting)会**保留** session→device 映射,deviceId 本身
  // 不变 —— 必须订阅设备 connected 状态,断连→重连的翻转才是重水合的真信号。
  // 本机会话恒 'local',零开销;断连翻转的那次重跑失败降级空表,无害。
  const remoteDevices = useRemoteDevices();
  const sessionDeviceId = sessionId ? getSessionDeviceId(sessionId) : undefined;
  const deviceConnectivity = sessionDeviceId
    ? `${sessionDeviceId}:${
        remoteDevices.find((d) => d.deviceId === sessionDeviceId)?.connected ? '1' : '0'
      }`
    : 'local';
  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    void listSessionBackgroundTasksFor(sessionId)
      .then(({ tasks }) => {
        if (disposed || !Array.isArray(tasks) || tasks.length === 0) return;
        makerChatStore.seedBackgroundTaskSnapshots(sessionId, tasks);
      })
      .catch(() => {
        // 静默:与 useBackgroundBashTasks 的快照失败同口径。
      });
    return () => {
      disposed = true;
    };
  }, [sessionId, taskUpdatesEmpty, deviceConnectivity]);

  const { running, completed } = useMemo(
    () =>
      listSessionTasks({
        // listSessionTasks 签名按 DB 行(ccAgent.types.Message)声明,其
        // readToolCall 已显式兼容 store 侧 ChatMessage 形态(顶层 toolName /
        // toolInput),此处按契约文档喂 store 消息数组,只做类型断言不改数据。
        messages: inputs.messages as unknown as readonly Message[],
        taskUpdates: inputs.taskUpdates,
        isSessionStreaming: inputs.isStreaming,
      }),
    [inputs],
  );

  // 历史 workflow 行的终态修正:workflow 的 tool_result 是启动回执(失败也存在),
  // 重载后 update 清空时消息推导只能给出 completed —— failed/stopped 会被涂绿。
  // 对无 update 但有 taskId 的终态 workflow 行 best-effort 读一次 wf 记录文件,
  // 用文件终态覆盖行状态;文件缺失 / 未收口保持推导现状。按 taskId 记忆,面板
  // 生命周期内每任务至多请求一次,不轮询;切会话清空重来。
  const [fileStatusByTaskId, setFileStatusByTaskId] = useState<
    ReadonlyMap<string, AgentTaskUpdate['status']>
  >(() => new Map());
  const fileStatusRequestedRef = useRef<Set<string>>(new Set());
  // deviceConnectivity 参与依赖:断连窗口内的补读全部 miss 且被记忆短路,重连
  // 翻转时清空重来(本机恒 'local' 不触发;已成功的重读幂等,set 同值短路)。
  useEffect(() => {
    fileStatusRequestedRef.current = new Set();
    setFileStatusByTaskId(new Map());
  }, [sessionId, deviceConnectivity]);
  useEffect(() => {
    if (!sessionId) return;
    const pending: string[] = [];
    const consider = (it: SessionTaskItem) => {
      if (it.kind !== 'workflow' || !it.taskId) return;
      // 有权威终态 update 的行不补读;无 update(历史推导)或 update 仍 running
      // (device-link 断连窗口可能丢终态事件 → stale running)都读文件核实 ——
      // 本机 live workflow 文件也在 running,映射为 null 不覆盖,只多一次读。
      if (it.update && it.update.status !== 'running') return;
      if (fileStatusRequestedRef.current.has(it.taskId)) return;
      fileStatusRequestedRef.current.add(it.taskId);
      pending.push(it.taskId);
    };
    for (const it of completed) consider(it);
    for (const it of running) consider(it);
    if (pending.length === 0) return;
    let disposed = false;
    // 串行而非并发:每次 miss 都可能触发 main 侧跨 session 目录扫描(远程会话
    // 则是隧道往返),多行同时 fan-out 会同时打出成倍的重复 IO;串行把它压成
    // 温和的背景补读,per-task 记忆保证每任务至多一次。
    let inFlightIndex = -1;
    void (async () => {
      for (let i = 0; i < pending.length; i++) {
        if (disposed) return; // 只停发新请求;在飞的那次照常落地(见下)
        inFlightIndex = i;
        const taskId = pending[i];
        let mapped: ReturnType<typeof fileStatusToTaskStatus> = null;
        try {
          const progress = await getWorkflowProgressFor(sessionId, taskId);
          mapped = fileStatusToTaskStatus(progress?.status);
        } catch {
          // 静默:与 wf 文件辅源的其余读取同口径,保持推导状态。
        }
        // 结果落地**不看 disposed**:live workflow 每个进度帧都会重建 running
        // 数组触发本 effect 重跑,若在飞结果被丢弃 + 退回记忆,就变成每帧一次
        // 文件重读。组件仍挂载时 setState 安全;卸载后 React 静默忽略。
        // miss(mapped=null)同样算「已请求过」,不退回不重试。
        if (mapped) {
          const status = mapped;
          setFileStatusByTaskId((prev) => {
            if (prev.get(taskId) === status) return prev;
            const next = new Map(prev);
            next.set(taskId, status);
            return next;
          });
        }
      }
    })();
    return () => {
      disposed = true;
      // 只退回**尚未发起**的项:completed 中途变化(快照水合 seed 等)不得让
      // 剩余批次被永久跳过;在飞项会自行落地,不退回(否则重复读)。
      for (let i = inFlightIndex + 1; i < pending.length; i++) {
        fileStatusRequestedRef.current.delete(pending[i]);
      }
    };
  }, [sessionId, completed, running, deviceConnectivity]);
  // 文件终态应用:completed 区无 update 的行原地覆盖;running 区命中终态的
  // workflow 行(掉线丢终态事件的 stale running)整行移入 completed 区 ——
  // 否则列表永久转圈、详情却按文件显示 done,同屏自相矛盾。
  const { runningResolved, completedResolved } = useMemo(() => {
    if (fileStatusByTaskId.size === 0) {
      return { runningResolved: running, completedResolved: completed };
    }
    const moved: SessionTaskItem[] = [];
    const runningKept = running.filter((it) => {
      if (it.kind !== 'workflow' || !it.taskId) return true;
      const fileStatus = fileStatusByTaskId.get(it.taskId);
      if (!fileStatus) return true;
      moved.push({ ...it, status: fileStatus });
      return false;
    });
    const completedPatched = completed.map((it) => {
      if (it.kind !== 'workflow' || it.update || !it.taskId) return it;
      const fileStatus = fileStatusByTaskId.get(it.taskId);
      return fileStatus && fileStatus !== it.status ? { ...it, status: fileStatus } : it;
    });
    return {
      runningResolved: runningKept,
      completedResolved: moved.length > 0 ? [...moved, ...completedPatched] : completedPatched,
    };
  }, [running, completed, fileStatusByTaskId]);

  // 详情选中:存 item.key(跨状态翻转稳定);列表条目消失时若无合成兜底则回列表。
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // focus 未命中时的合成详情兜底(独立侧栏窗口只加载最新 50 条消息,老 workflow
  // 的 toolCall 不在窗口内 → 列表产不出行,但 wf 文件读取只需 taskId)。key 与
  // 真行同为 taskId:列表稍后真的出现该行时 find 顺序自动切到真行。
  const [syntheticFocusItem, setSyntheticFocusItem] = useState<SessionTaskItem | null>(null);
  const selectedItem = useMemo(() => {
    if (!selectedKey) return null;
    return (
      runningResolved.find((it) => it.key === selectedKey) ??
      completedResolved.find((it) => it.key === selectedKey) ??
      (syntheticFocusItem?.key === selectedKey ? syntheticFocusItem : null)
    );
  }, [selectedKey, runningResolved, completedResolved, syntheticFocusItem]);

  // focusTaskId(tab state)消费:列表命中 → 进对应详情;未命中(消息窗口外的
  // 老 workflow)→ 合成 file-only 详情兜底,点开面板不落空。消费即清,避免跨
  // 重启反复弹详情。
  const focusTaskId = state.focusTaskId ?? null;
  useEffect(() => {
    if (!focusTaskId) return;
    const target =
      runningResolved.find((it) => it.kind === 'workflow' && it.taskId === focusTaskId) ??
      completedResolved.find((it) => it.kind === 'workflow' && it.taskId === focusTaskId);
    if (target) {
      setSelectedKey(target.key);
    } else {
      setSyntheticFocusItem({
        key: focusTaskId,
        taskId: focusTaskId,
        kind: 'workflow',
        title: '',
        // 合成行必是历史任务(点击来自已存在的卡片):completed 让 Stop 不出现,
        // 详情树的真实终态由 wf 文件与 buildWorkflowTreeModel 裁决。
        status: 'completed',
        provider: 'claude-code',
        orderIndex: -1,
      });
      setSelectedKey(focusTaskId);
    }
    ctx.patchState({ focusTaskId: null });
  }, [focusTaskId, runningResolved, completedResolved, ctx]);

  const handleOpenWorkflow = useCallback((key: string) => {
    setSelectedKey(key);
  }, []);
  const handleBack = useCallback(() => {
    setSelectedKey(null);
  }, []);

  if (selectedItem && selectedItem.kind === 'workflow') {
    // key 强制换任务时重挂载:WorkflowDetail 内部持有 fileProgress state,原地复用
    // 会把上一个任务的 wf 文件数据(logs/detail/聚合)残留合进新任务的树。
    return (
      <WorkflowDetail
        key={selectedItem.key}
        item={selectedItem}
        sessionId={sessionId}
        onBack={handleBack}
      />
    );
  }

  if (runningResolved.length === 0 && completedResolved.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <ListTodo size={20} className="text-[var(--text-tertiary)]" aria-hidden="true" />
        <div className="text-12 text-[var(--text-tertiary)]">
          {t('rightSidebar.backgroundTasks.empty')}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
      {runningResolved.length > 0 && (
        <>
          <SectionHeader label={t('rightSidebar.backgroundTasks.running')} />
          {runningResolved.map((item) => (
            <TaskRow
              key={item.key}
              item={item}
              sessionId={sessionId}
              onOpenWorkflow={handleOpenWorkflow}
            />
          ))}
        </>
      )}
      {completedResolved.length > 0 && (
        <>
          <SectionHeader label={t('rightSidebar.backgroundTasks.completed')} />
          {completedResolved.map((item) => (
            <TaskRow
              key={item.key}
              item={item}
              sessionId={sessionId}
              onOpenWorkflow={handleOpenWorkflow}
            />
          ))}
        </>
      )}
    </div>
  );
}
