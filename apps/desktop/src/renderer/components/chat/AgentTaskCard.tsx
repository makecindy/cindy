import { Fragment, useEffect, useMemo, useCallback, useState } from 'react';
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleStop,
  LoaderCircle,
  PanelRight,
  Square,
  SquareTerminal,
  Workflow,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useExpandedBlockMemory } from '@/hooks/useExpandedBlockMemory';
import { Collapse } from '@/components/ui/collapse';
import { Spinner } from '@/components/ui/spinner';
import type { AgentTaskUpdate, ChatMessage } from '@/hooks/useCCAgentChat';
import { getWorkflowProgressFor, isRemoteSessionSticky } from '@/lib/makerTransport';
import { openBackgroundTasksTab } from '@/features/right-sidebar/lib/openBackgroundTasksTab';
import { extractWorkflowTaskId } from '@/features/right-sidebar/plugins/background-tasks/listSessionTasks';
import { WorkflowAgentStrip } from '@/features/right-sidebar/plugins/background-tasks/WorkflowAgentStrip';
import {
  fileStatusToTaskStatus,
  workflowAgentVisualState,
} from '@/features/right-sidebar/plugins/background-tasks/workflowProgressModel';
import { useSidebarPanelReachable } from '@/features/cc-agent/embeddedSessionNavigation';
import { cn } from '@/lib/utils';
import { formatModelShortLabel } from '@/lib/modelShortLabel';

interface AgentTaskCardProps {
  toolCall?: ChatMessage;
  update?: AgentTaskUpdate;
  result?: string;
  /**
   * subagent-model-chip: 子代理实际跑的模型 raw id,由 MessageStream 用
   * parentToolUseId→model 映射(从子消息 agentMeta 反查)解析后传入,作为
   * 历史重载(此时 update 为空)时的兜底来源。实时态优先用 update.model。
   */
  subagentModel?: string;
  /**
   * 当前会话 id。workflow 卡用于打开右栏后台任务面板并定位详情;stop 按钮
   * 定位任务也依赖它。
   */
  sessionId?: string;
}

function readInputString(input: unknown, keys: string[]): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function compactText(text: string | undefined, max = 260): string | undefined {
  if (!text) return undefined;
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

function detailText(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function formatDuration(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function statusIcon(status: AgentTaskUpdate['status']) {
  if (status === 'completed') return CheckCircle2;
  if (status === 'failed') return AlertCircle;
  if (status === 'stopped') return CircleStop;
  return LoaderCircle;
}

/**
 * workflow 历史卡文件终态读取的模块级共享(key = sessionId+taskId):历史会话
 * 可能同屏多张卡,各读一遍会把 main 侧跨目录扫描放大 N 倍。终态文件不可变,
 * 正结果永久有效;负结果(读不到)同样缓存 —— 历史卡的文件早已定型,与面板
 * 补读的 per-task 记忆同口径,不轮询不重试。
 */
const historyFileStatusCache = new Map<
  string,
  Promise<'completed' | 'failed' | 'stopped' | null>
>();

function readHistoryFileStatus(
  sessionId: string,
  taskId: string,
): Promise<'completed' | 'failed' | 'stopped' | null> {
  const key = `${sessionId} ${taskId}`;
  let pending = historyFileStatusCache.get(key);
  if (!pending) {
    pending = getWorkflowProgressFor(sessionId, taskId)
      .then((progress) => {
        const mapped = fileStatusToTaskStatus(progress?.status);
        // 只缓存终态:null(文件缺失/未收口)可能是终态通知先于落盘的窄窗口,
        // 永久缓存会把这张卡钉死在推导状态 —— 让下次挂载重读。
        if (mapped === null) historyFileStatusCache.delete(key);
        return mapped;
      })
      .catch(() => {
        historyFileStatusCache.delete(key);
        return null;
      });
    historyFileStatusCache.set(key, pending);
  }
  return pending;
}

export function AgentTaskCard({ toolCall, update, result, subagentModel, sessionId }: AgentTaskCardProps) {
  const { t } = useTranslation();
  const blockId = `task:${toolCall?.clientId ?? update?.taskId ?? 'unknown'}`;
  // subagent-model-chip: 子代理模型 —— 实时态优先 update.model(progress 事件
  // 带),历史重载(update 缺省)回退到从子消息反查的 subagentModel。两者皆无
  // (如 codex collab 任务 / 旧数据)则不渲染 chip。
  const modelLabel = formatModelShortLabel(update?.model ?? subagentModel);
  const { expanded, setExpanded } = useExpandedBlockMemory(blockId);
  const toggle = useCallback(() => setExpanded((v) => !v), [setExpanded]);

  // workflow-card: Workflow 工具在父会话事件流里是单个 local_workflow 任务(内部子 agent
  // 不发独立 task 事件,只有 workflow 级聚合进度)。按 taskType / toolName 识别:标题优先取
  // workflowName、头像换 Workflow 图标、provider 标签显示 "Workflow"。workflow 卡不展开 ——
  // 主视图在右栏「后台任务」面板,整卡是打开面板并定位详情的入口。
  const isWorkflow = update?.taskType === 'local_workflow' || toolCall?.toolName === 'Workflow';
  // 历史重载(update 清空)从 tool_result 文本恢复任务 id —— 与面板
  // listSessionTasks 同一提取实现,保证 focusTaskId 两边配得上。
  const workflowTaskId = update?.taskId ?? (isWorkflow ? extractWorkflowTaskId(result) : undefined);

  // workflow 历史卡的状态真相:tool_result 只是启动回执(失败也存在),拿它断言
  // completed 会给 failed/stopped 涂绿,与面板列表行(已做文件修正)同屏矛盾。
  // 读一次 wf 文件终态覆盖(与面板同源);读不到(SSH 等声明过的降级边界)保持推导。
  const [historyFileStatus, setHistoryFileStatus] = useState<
    'completed' | 'failed' | 'stopped' | null
  >(null);
  useEffect(() => {
    if (!isWorkflow || update?.status || !sessionId || !workflowTaskId) return;
    let disposed = false;
    try {
      // 经模块级缓存共享:同屏多张历史卡同 taskId 只读一次(见 readHistoryFileStatus)。
      void readHistoryFileStatus(sessionId, workflowTaskId).then((mapped) => {
        if (disposed) return;
        if (mapped) setHistoryFileStatus(mapped);
      });
    } catch {
      // 静默:transport 不可用(极端环境)同样保持推导状态。
    }
    return () => {
      disposed = true;
    };
  }, [isWorkflow, update?.status, sessionId, workflowTaskId]);

  const status =
    update?.status ??
    (isWorkflow ? (historyFileStatus ?? (result ? 'completed' : 'running')) : result ? 'completed' : 'running');
  const StatusIcon = statusIcon(status);
  const statusIconClassName = cn(
    'text-[var(--text-secondary)]',
    status === 'failed' && 'text-[var(--error-fg)]',
  );
  // bash-task-card: 后台 Bash(run_in_background)与子 Agent 共用本卡,但视觉上
  // 是「后台命令」—— 终端图标 + shell provider 标签,避免用户把跑测试的 bash
  // 误读成一个子 Agent。
  const isBash = update?.taskType === 'local_bash';
  const AvatarIcon = isWorkflow ? Workflow : isBash ? SquareTerminal : Bot;
  const title = compactText(
    (isWorkflow ? update?.workflowName : undefined) ??
      update?.title ??
      readInputString(toolCall?.toolInput, ['description', 'task', 'name']) ??
      readInputString(toolCall?.toolInput, ['prompt']),
    96,
  ) ?? t(isWorkflow ? 'chat.agentTask.provider.workflow' : 'chat.agentTask.emptyTitle');
  const description = compactText(
    update?.description ??
      readInputString(toolCall?.toolInput, ['prompt', 'description', 'task']),
  );
  const summary = detailText(result, update?.summary);
  const duration = formatDuration(update?.usage?.durationMs);
  const provider = update?.provider ?? (toolCall?.toolName?.startsWith('collab:') ? 'codex' : 'claude-code');
  const providerLabel = isWorkflow
    ? t('chat.agentTask.provider.workflow')
    : isBash
      ? t('chat.agentTask.provider.shell')
      : provider === 'codex'
        ? t('chat.agentTask.provider.codex')
        : t('chat.agentTask.provider.claude');

  // 停止按钮:running + 本会话可定位 + claude-code(codex 无 stopTask 通道)。
  // 点击后交给 main 的 stopAgentTask;成功与否都由 task_notification 事件流收口
  // (状态翻 stopped → 按钮自然消失),这里只管在飞态防连点。失败静默恢复 ——
  // 任务恰好自然结束时 stop 是幂等成功,真失败(不支持等)保持 running 状态可重试。
  const [stopping, setStopping] = useState(false);
  const canStop =
    status === 'running' &&
    Boolean(sessionId) &&
    Boolean(update?.taskId) &&
    update?.provider === 'claude-code' &&
    // device-link 镜像会话:session 活在被控端,本地 stopAgentTask 会假成功 —— 不给
    // 按钮。粘滞判定:relay 瞬断清空注册表的窗口内不误判为本机(与面板同口径)。
    !(sessionId && isRemoteSessionSticky(sessionId));
  const handleStop = useCallback(() => {
    const api = window.electronAPI?.maker;
    if (!sessionId || !update?.taskId || !api?.stopAgentTask) return;
    setStopping(true);
    void api
      .stopAgentTask(sessionId, update.taskId)
      .catch(() => {
        // 静默:失败时卡片仍显示 running,用户可重试;不弹打断式错误。
      })
      .finally(() => setStopping(false));
  }, [sessionId, update?.taskId]);

  // workflow 卡整卡点击 → 打开右栏后台任务面板并定位本任务(workflowTaskId 在
  // 组件顶部与状态修正共用同一次推导)。三者缺一就退回传统展开交互,让
  // description/summary 就地可读,不做「点了没反应」的假入口。
  //
  // panelReachable:内嵌宿主(协同 worker 面板 / workdir-browse 窄 rail / Orca
  // split)里右栏显示的是别的会话(或压根没在场),往本会话 bucket 写 tab 用户看
  // 不到 —— 那里必须退回展开区,否则卡片既点不动、又因面板入口化丢掉了展开区。
  const panelReachable = useSidebarPanelReachable(sessionId);
  const canOpenInPanel = Boolean(sessionId) && Boolean(workflowTaskId) && panelReachable;
  const openInPanel = useCallback(() => {
    if (!sessionId || !workflowTaskId) return;
    void openBackgroundTasksTab(sessionId, { focusTaskId: workflowTaskId });
  }, [sessionId, workflowTaskId]);

  // workflow 摘要行:当前运行中 agent 的 phaseTitle + 已收口/总数。收口判定走
  // workflowAgentVisualState 归一(与方块条 / 面板同一词表源,done 与 failed 都算收口)。
  const workflowSummary = useMemo(() => {
    if (!isWorkflow) return null;
    const entries = update?.workflowProgress;
    if (!entries || entries.length === 0) return null;
    let total = 0;
    let done = 0;
    let phase: string | undefined;
    for (const entry of entries) {
      if (entry.type !== 'workflow_agent') continue;
      total += 1;
      const visual = workflowAgentVisualState(entry.state);
      if (visual === 'done' || visual === 'failed') {
        done += 1;
      } else if (visual === 'running' && entry.phaseTitle) {
        phase = entry.phaseTitle;
      }
    }
    return total > 0 ? { phase, done, total } : null;
  }, [isWorkflow, update?.workflowProgress]);

  // 方块条数据:workflow_agent 条目按 spawn 顺序透传(state/label)。
  const workflowAgentCells = useMemo(() => {
    if (!isWorkflow) return [];
    return (update?.workflowProgress ?? [])
      .filter((entry) => entry.type === 'workflow_agent')
      .map((entry) => ({
        ...(entry.state !== undefined ? { state: entry.state } : {}),
        ...(entry.label !== undefined ? { label: entry.label } : {}),
      }));
  }, [isWorkflow, update?.workflowProgress]);

  const meta = useMemo(() => {
    const parts: Array<{ key: string; text: string }> = [
      { key: 'provider', text: providerLabel },
      { key: 'status', text: t(`chat.agentTask.status.${status}`) },
    ];
    if (typeof update?.usage?.totalTokens === 'number') {
      parts.push({ key: 'tokens', text: t('chat.agentTask.tokens', { count: update.usage.totalTokens }) });
    }
    if (typeof update?.usage?.toolUses === 'number') {
      parts.push({ key: 'toolUses', text: t('chat.agentTask.toolUses', { count: update.usage.toolUses }) });
    }
    if (duration) parts.push({ key: 'duration', text: duration });
    return parts;
  }, [duration, providerLabel, status, t, update?.usage?.totalTokens, update?.usage?.toolUses]);

  return (
    // data-message-client-id:MessageStream 的消息级 focus(后台任务面板行点击 /
    // 搜索跳转)靠该锚点滚动定位 —— 普通消息行有,任务卡也必须有,否则面板点
    // Agent/Bash 行会静默无反应。
    <div
      className="flex w-full justify-start"
      {...(toolCall?.clientId ? { 'data-message-client-id': toolCall.clientId } : {})}
    >
      <div className="w-full rounded-[12px] border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2">
        {/* 头部按钮:普通卡 = 展开 toggle;workflow 卡 = 打开后台任务面板入口。
            button 不能嵌套,停止按钮以兄弟节点挂在右侧(仅 running 时出现)。 */}
        <div className="flex w-full items-start gap-2">
        <button
          type="button"
          onClick={isWorkflow && canOpenInPanel ? openInPanel : toggle}
          className="flex min-w-0 flex-1 items-start gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          {...(isWorkflow && canOpenInPanel
            ? { 'aria-label': t('chat.agentTask.openInPanel') }
            : {
                'aria-expanded': expanded,
                'aria-label': expanded
                  ? t('chat.agentTask.hideDetails')
                  : t('chat.agentTask.showDetails'),
              })}
        >
          <span className="mt-[2px] inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-secondary)]">
            <AvatarIcon size={14} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <Spinner
                icon={StatusIcon}
                size={14}
                spinning={status === 'running'}
                className={statusIconClassName}
              />
              <span className="truncate text-14 font-medium leading-5 text-[var(--text-primary)]">
                {title}
              </span>
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-12 leading-4 text-[var(--text-tertiary)]">
              {meta.map((part) => (
                <Fragment key={part.key}>
                  <span>{part.text}</span>
                  {/* subagent-model-chip: 模型 chip 紧跟在 provider(Claude Code)之后,
                      与 meta 文本同处第二行。 */}
                  {part.key === 'provider' && modelLabel && (
                    <span
                      data-agent-task-model-chip="true"
                      // 字体不特殊处理:size / weight / color 全部继承 meta 行
                      // (text-12 / normal / --text-tertiary),只保留 chip 的底色与圆角。
                      className="inline-flex items-center rounded-[4px] bg-[var(--surface-chip)] px-1.5 py-0.5"
                    >
                      {modelLabel}
                    </span>
                  )}
                </Fragment>
              ))}
            </span>
            {workflowSummary && (
              <span
                data-workflow-progress-line="true"
                className="mt-0.5 block truncate text-12 leading-4 text-[var(--text-tertiary)]"
              >
                {workflowSummary.phase
                  ? t('chat.agentTask.workflowProgressLine', {
                      phase: workflowSummary.phase,
                      done: workflowSummary.done,
                      total: workflowSummary.total,
                    })
                  : t('chat.agentTask.workflowProgressCount', {
                      done: workflowSummary.done,
                      total: workflowSummary.total,
                    })}
              </span>
            )}
            {workflowAgentCells.length > 0 && (
              // 逐 agent 状态方块条:卡片紧凑场景截断到 40 格,总览细节进面板。
              <span className="mt-1 block">
                <WorkflowAgentStrip cells={workflowAgentCells} maxVisible={40} />
              </span>
            )}
          </span>
          {isWorkflow && canOpenInPanel ? (
            <PanelRight
              size={14}
              className="mt-1 shrink-0 text-[var(--text-tertiary)]"
              aria-hidden="true"
            />
          ) : (
            <ChevronRight
              size={14}
              className={cn(
                'mt-1 shrink-0 text-[var(--text-tertiary)]',
                'transition-transform duration-[var(--motion-fast,150ms)]',
                expanded && 'rotate-90',
              )}
              aria-hidden="true"
            />
          )}
        </button>
        {canStop && (
          <button
            type="button"
            onClick={handleStop}
            disabled={stopping}
            title={t('chat.agentTask.stop')}
            aria-label={t('chat.agentTask.stop')}
            data-agent-task-stop="true"
            className={cn(
              'mt-[2px] inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px]',
              'text-[var(--text-secondary)] hover:bg-[var(--surface-chip)] hover:text-[var(--text-primary)]',
              'transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
            )}
          >
            <Square size={11} aria-hidden="true" />
          </button>
        )}
        </div>

        {/* live workflow 卡不渲染展开区(详情在后台任务面板);历史 workflow 卡
            (无 live taskId,面板无数据)保留展开区兜底展示 description/summary。 */}
        {!(isWorkflow && canOpenInPanel) && (
          <Collapse open={expanded}>
            <div className="mt-2 border-l-2 border-[var(--agent-actions-rail)] pl-3 text-13 leading-5 text-[var(--text-secondary)]">
              {description && <p className="mb-1">{description}</p>}
              {summary && <p className="mb-1 whitespace-pre-wrap">{summary}</p>}
              {update?.lastToolName && (
                <p className="text-12 leading-4 text-[var(--text-tertiary)]">
                  {t('chat.agentTask.lastTool', { tool: update.lastToolName })}
                </p>
              )}
              {update?.outputFile && (
                <p className="text-12 leading-4 text-[var(--text-tertiary)]">
                  {t('chat.agentTask.outputFile', { path: update.outputFile })}
                </p>
              )}
            </div>
          </Collapse>
        )}
      </div>
    </div>
  );
}
