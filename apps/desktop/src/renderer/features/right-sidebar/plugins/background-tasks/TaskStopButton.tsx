/**
 * [INPUT]: depends on Button/Tip, background-task stop transports and react-i18next
 * [OUTPUT]: exports TaskStopButton for task, Workflow and Workflow-Agent scopes
 * [POS]: shared stop control for chat task cards and the background-tasks sidebar
 * [PROTOCOL]: Update this header on change, then check CLAUDE.md
 */

import { useCallback, useRef, useState, type MouseEvent } from 'react';
import { Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { stopBackgroundTask, stopWorkflowAgent } from '@/lib/backgroundTaskStop';
import { reportBackgroundTaskStopFailure } from '@/lib/backgroundTaskStopFailure';
import { cn } from '@/lib/utils';

interface TaskStopButtonProps {
  sessionId: string;
  taskId: string;
  scope: 'task' | 'workflow' | 'workflow-agent';
  /** workflow-agent 必须提供当前行的真实 agentId;label 只用于可读名称。 */
  agent?: { id: string; label: string };
  /** 停止/取消使用既有 danger 红色;非破坏性普通任务保持中性。 */
  danger?: boolean;
  /** 详情头部显示“停止全部”;其余位置使用纯图标 + Tip。 */
  showLabel?: boolean;
  className?: string;
}

export function TaskStopButton({
  sessionId,
  taskId,
  scope,
  agent,
  danger = false,
  showLabel = false,
  className,
}: TaskStopButtonProps) {
  const { t } = useTranslation();
  const [stopping, setStopping] = useState(false);
  // React 重渲染前的同一帧连点也必须被挡住;disabled 只能约束渲染后的点击。
  const stoppingRef = useRef(false);
  const actionLabel =
    scope === 'workflow-agent'
      ? t('rightSidebar.backgroundTasks.stopAgent', {
          name: agent?.label ?? agent?.id ?? '',
        })
      : scope === 'workflow'
        ? t('rightSidebar.backgroundTasks.stopWorkflow')
        : t('rightSidebar.backgroundTasks.stop');
  const tipLabel = stopping
    ? `${actionLabel} — ${t('rightSidebar.backgroundTasks.stopping')}`
    : actionLabel;

  const handleStop = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      // 行/卡片点击用于打开详情;停止必须只执行自己的动作。
      event.stopPropagation();
      if (stoppingRef.current) return;
      if (scope === 'workflow-agent' && !agent?.id) return;
      stoppingRef.current = true;
      setStopping(true);
      const request =
        scope === 'workflow-agent'
          ? stopWorkflowAgent(sessionId, taskId, agent!.id)
          : stopBackgroundTask(sessionId, taskId);
      void request
        .catch((error: unknown) => {
          // 失败时保持真实 running 状态,允许用户重试;旧远程端会提示升级。
          reportBackgroundTaskStopFailure(error, t, scope);
        })
        .finally(() => {
          stoppingRef.current = false;
          setStopping(false);
        });
    },
    [agent, scope, sessionId, t, taskId],
  );

  return (
    <Tip text={tipLabel} side="bottom">
      <span
        {...(stopping
          ? {
              role: 'button',
              tabIndex: 0,
              'aria-disabled': true,
              'aria-label': tipLabel,
            }
          : {})}
        className={cn(
          'inline-flex shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
          className,
        )}
      >
        <Button
          type="button"
          variant="secondary"
          tone={danger ? (showLabel ? 'danger-solid' : 'danger') : 'quiet'}
          size="sm"
          compact={showLabel}
          loading={stopping}
          onClick={handleStop}
          aria-label={actionLabel}
          aria-hidden={stopping ? true : undefined}
          data-agent-task-stop="true"
          {...(scope === 'workflow-agent' && agent?.id
            ? { 'data-workflow-agent-stop': agent.id }
            : {})}
          className={showLabel ? 'px-3' : 'w-7 px-0'}
        >
          <Square
            size={showLabel ? 10 : 11}
            fill={danger ? 'currentColor' : 'none'}
            aria-hidden="true"
          />
          {showLabel && <span>{t('chat.backgroundActivity.stopAll')}</span>}
        </Button>
      </span>
    </Tip>
  );
}
