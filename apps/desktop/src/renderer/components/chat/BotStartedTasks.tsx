/**
 * Tasks a teammate started or handed work to in one reply, shown under that reply in the teammate
 * chat: one light chip per task that opens it (2026-11-10). The teammate's tool steps stay folded, so
 * without this the owner had only the reply text to find the task. Read from the `send_to_session`
 * receipts of the turn, not from what the reply says.
 */
import { useSyncExternalStore } from 'react';
import { ChevronRight, CornerDownRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { ChatMessage } from '@/hooks/useCCAgentChat';
import { useSessionNavigationMode } from '@/features/cc-agent/embeddedSessionNavigation';
import { remoteProjectsStore, useRemoteSessionTitle } from '@/features/device-link/remoteProjectsStore';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { sessionsStore } from '@/lib/sessionsStore';
import { cn } from '@/lib/utils';
import { isCrossDeviceSourceSessionId } from '@cindy/maker-shared/message-source';

import { CHAT_COLOR_TRANSITION_CLASS, CHAT_FOCUS_CLASS } from './chatChrome';

export interface BotStartedTask {
  sessionId: string;
  /** Title from the receipt; the live title wins when this computer knows the task. */
  title: string | null;
  created: boolean;
}

function isSendToSession(message: ChatMessage): boolean {
  const name = message.toolName ?? '';
  if (/send_to_session$/.test(name)) return true;
  if (!/call_tool$/.test(name)) return false;
  let input = message.toolInput as { name?: unknown } | string | null | undefined;
  if (typeof input === 'string') { try { input = JSON.parse(input) as { name?: unknown }; } catch { return false; } }
  return typeof input === 'object' && input?.name === 'send_to_session';
}

function receiptOf(content: unknown): Record<string, unknown> | null {
  const read = (value: unknown): Record<string, unknown> | null => {
    if (typeof value === 'string') {
      try { return read(JSON.parse(value)); } catch { return null; }
    }
    if (Array.isArray(value)) {
      for (const part of value) {
        const found = read((part as { text?: unknown } | null)?.text ?? part);
        if (found) return found;
      }
      return null;
    }
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
  };
  const receipt = read(content);
  return receipt?.ok === true && typeof receipt.target_session_id === 'string' ? receipt : null;
}

/** The tasks one turn started or sent work to, in order, once each. */
export function collectBotStartedTasks(turn: readonly ChatMessage[]): BotStartedTask[] {
  const sends = new Set(turn.filter((message) => message.role === 'tool_use' && isSendToSession(message))
    .map((message) => message.toolUseId).filter((id): id is string => typeof id === 'string'));
  const tasks = new Map<string, BotStartedTask>();
  for (const message of turn) {
    if (message.role !== 'tool_result' || !message.toolUseId || !sends.has(message.toolUseId)) continue;
    const receipt = receiptOf(message.content);
    if (!receipt) continue;
    const sessionId = receipt.target_session_id as string;
    const previous = tasks.get(sessionId);
    tasks.set(sessionId, {
      sessionId,
      title: typeof receipt.target_title === 'string' && receipt.target_title.trim()
        ? receipt.target_title.trim() : previous?.title ?? null,
      created: previous?.created === true || receipt.wake_kind === 'created',
    });
  }
  return [...tasks.values()];
}

function TaskChip({ task, hostSessionId }: { task: BotStartedTask; hostSessionId?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const navigationMode = useSessionNavigationMode();
  // A remote chat's tasks live on that computer, like the message source labels.
  const hostDeviceId = getStickySessionDeviceId(hostSessionId);
  const localTitle = useSyncExternalStore(
    (onChange) => sessionsStore.subscribe(onChange),
    () => (hostDeviceId ? null : sessionsStore.getTitleById(task.sessionId)),
  );
  const remoteTitle = useRemoteSessionTitle(hostDeviceId ? task.sessionId : undefined);
  const title = (hostDeviceId ? remoteTitle : localTitle) || task.title || t('chat.botStartedTasks.untitled');
  const openable = navigationMode !== 'sidebar-embedded' && !isCrossDeviceSourceSessionId(task.sessionId);
  const content = (
    <>
      <CornerDownRight size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-[var(--text-secondary)]" />
      <span className="min-w-0 truncate">{title}</span>
      {openable ? <ChevronRight size={14} aria-hidden className="shrink-0 text-[var(--text-tertiary)]" /> : null}
    </>
  );
  const chipClass = 'inline-flex h-7 max-w-[320px] items-center gap-1.5 rounded-full bg-[var(--msg-md-inline-code-bg)] px-2.5 text-13 font-medium text-[var(--msg-assistant-text)]';
  if (!openable) return <span className={chipClass} title={title}>{content}</span>;
  return (
    <button
      type="button"
      data-split-pane-route-action=""
      title={t('chat.botStartedTasks.open', { title })}
      aria-label={t('chat.botStartedTasks.open', { title })}
      onClick={() => {
        if (hostDeviceId) remoteProjectsStore.pinSessionOrigin(hostDeviceId, task.sessionId);
        navigate(`/cc-agent/${encodeURIComponent(task.sessionId)}`);
      }}
      className={cn(chipClass, CHAT_FOCUS_CLASS, CHAT_COLOR_TRANSITION_CLASS, 'hover:bg-[var(--cmd-palette-item-hover)]')}
    >
      {content}
    </button>
  );
}

export function BotStartedTasks({ tasks, hostSessionId }: { tasks: readonly BotStartedTask[]; hostSessionId?: string }) {
  const { t } = useTranslation();
  if (tasks.length === 0) return null;
  return (
    <div className="my-1 flex max-w-[680px] flex-col gap-2" data-testid="bot-started-tasks">
      <span className="text-12 font-medium text-[var(--text-secondary)]">
        {t(tasks.some((task) => task.created) ? 'chat.botStartedTasks.started' : 'chat.botStartedTasks.handedTo')}
      </span>
      <div className="flex flex-wrap gap-2">
        {tasks.map((task) => <TaskChip key={task.sessionId} task={task} hostSessionId={hostSessionId} />)}
      </div>
    </div>
  );
}
