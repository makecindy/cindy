import { Fragment, useMemo, useCallback, useState } from 'react';
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleStop,
  LoaderCircle,
  Square,
  SquareTerminal,
  Workflow,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useExpandedBlockMemory } from '@/hooks/useExpandedBlockMemory';
import { Collapse } from '@/components/ui/collapse';
import { Spinner } from '@/components/ui/spinner';
import type { AgentTaskUpdate, ChatMessage } from '@/hooks/useCCAgentChat';
import { isRemoteSession } from '@/lib/makerTransport';
import { cn } from '@/lib/utils';
import { formatModelShortLabel } from '@/lib/modelShortLabel';
import { WorkflowAgentTree } from './WorkflowAgentTree';

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
   * workflow-card: 当前会话 id。仅 workflow 卡片用来经 IPC 拉逐 agent 进度树
   * (getWorkflowProgress(sessionId, taskId));普通 Agent/Task 卡片不需要。
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

export function AgentTaskCard({ toolCall, update, result, subagentModel, sessionId }: AgentTaskCardProps) {
  const { t } = useTranslation();
  const blockId = `task:${toolCall?.clientId ?? update?.taskId ?? 'unknown'}`;
  // subagent-model-chip: 子代理模型 —— 实时态优先 update.model(progress 事件
  // 带),历史重载(update 缺省)回退到从子消息反查的 subagentModel。两者皆无
  // (如 codex collab 任务 / 旧数据)则不渲染 chip。
  const modelLabel = formatModelShortLabel(update?.model ?? subagentModel);
  const { expanded, setExpanded } = useExpandedBlockMemory(blockId);
  const toggle = useCallback(() => setExpanded((v) => !v), [setExpanded]);

  const status = update?.status ?? (result ? 'completed' : 'running');
  const StatusIcon = statusIcon(status);
  const statusIconClassName = cn(
    'text-[var(--text-secondary)]',
    status === 'failed' && 'text-[var(--error-fg)]',
  );
  // workflow-card: Workflow 工具在父会话事件流里是单个 local_workflow 任务(内部子 agent
  // 不发独立 task 事件,只有 workflow 级聚合进度)。按 taskType / toolName 识别:标题优先取
  // workflowName、头像换 Workflow 图标、provider 标签显示 "Workflow";其余(状态 / 聚合
  // usage / 展开详情)复用本卡既有逻辑。
  const isWorkflow = update?.taskType === 'local_workflow' || toolCall?.toolName === 'Workflow';
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
    // device-link 镜像会话:session 活在被控端,本地 stopAgentTask 会假成功 —— 不给按钮。
    !(sessionId && isRemoteSession(sessionId));
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
    <div className="flex w-full justify-start">
      <div
        // workflow-card: /workflows 命令据此 data 属性在**本会话作用域内**定位最近一张
        // workflow 卡(data-workflow-session 限定会话,防多会话同挂 DOM 时选错),并用
        // data-workflow-expandkey(= 本卡的 useExpandedBlockMemory blockId)命令式展开它。
        {...(isWorkflow
          ? {
              'data-workflow-card': 'true',
              'data-workflow-session': sessionId ?? '',
              'data-workflow-expandkey': blockId,
            }
          : {})}
        className="w-full rounded-[12px] border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2"
      >
        {/* 折叠头 = 展开 toggle + 可选的停止按钮。button 不能嵌套,停止按钮以
            兄弟节点挂在 toggle 右侧(仅 running 时出现)。 */}
        <div className="flex w-full items-start gap-2">
        <button
          type="button"
          onClick={toggle}
          className="flex min-w-0 flex-1 items-start gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          aria-expanded={expanded}
          aria-label={expanded ? t('chat.agentTask.hideDetails') : t('chat.agentTask.showDetails')}
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
          </span>
          <ChevronRight
            size={14}
            className={cn(
              'mt-1 shrink-0 text-[var(--text-tertiary)]',
              'transition-transform duration-[var(--motion-fast,150ms)]',
              expanded && 'rotate-90',
            )}
            aria-hidden="true"
          />
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
            {/* workflow-card: 逐 agent 进度树(增强)。读不到记录 → 渲染 null,上面的
                workflow 级信息(名字/状态/聚合 usage)照常展示,即 v1 形态优雅回退。 */}
            {isWorkflow && (
              <WorkflowAgentTree
                {...(sessionId ? { sessionId } : {})}
                {...(update?.taskId ? { taskId: update.taskId } : {})}
                isRunning={status === 'running'}
              />
            )}
          </div>
        </Collapse>
      </div>
    </div>
  );
}
