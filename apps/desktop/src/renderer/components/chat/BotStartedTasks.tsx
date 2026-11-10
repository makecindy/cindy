/**
 * Tasks a teammate started or handed work to in one reply, shown under that reply in the teammate
 * chat: one light chip per task that opens it (2026-11-10). The teammate's tool steps stay folded, so
 * without this the owner had only the reply text to find the task. Read from the `send_to_session`
 * receipts of the turn, not from what the reply says.
 */
import { useSyncExternalStore } from 'react';
import { ChevronDown, ChevronRight, CornerDownLeft, CornerDownRight } from 'lucide-react';
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
import type { RenderItem } from './messageWorkGroups';

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

/** The live title of a task this chat refers to; remote chats read that computer's mirror. */
export function useLinkedTaskTitle(sessionId: string | undefined, hostSessionId: string | undefined, fallback: string | null): string | null {
  const hostDeviceId = getStickySessionDeviceId(hostSessionId);
  const localTitle = useSyncExternalStore(
    (onChange) => sessionsStore.subscribe(onChange),
    () => (hostDeviceId || !sessionId ? null : sessionsStore.getTitleById(sessionId)),
  );
  const remoteTitle = useRemoteSessionTitle(hostDeviceId ? sessionId : undefined);
  return (hostDeviceId ? remoteTitle : localTitle) || fallback;
}

/** Opens a task this chat refers to, or null where the chat cannot navigate there. */
export function useOpenLinkedTask(sessionId: string | undefined, hostSessionId: string | undefined): (() => void) | null {
  const navigate = useNavigate();
  const navigationMode = useSessionNavigationMode();
  if (!sessionId || navigationMode === 'sidebar-embedded' || isCrossDeviceSourceSessionId(sessionId)) return null;
  return () => {
    // A remote chat's tasks live on that computer, like the message source labels.
    const hostDeviceId = getStickySessionDeviceId(hostSessionId);
    if (hostDeviceId) remoteProjectsStore.pinSessionOrigin(hostDeviceId, sessionId);
    navigate(`/cc-agent/${encodeURIComponent(sessionId)}`);
  };
}

/** The pill every task reference in a teammate chat uses: a started task, a letter from a task. */
export const BOT_TASK_PILL_CLASS = 'inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-full bg-[var(--msg-md-inline-code-bg)] px-2.5 text-13 text-[var(--msg-assistant-text)]';

function TaskChip({ task, hostSessionId }: { task: BotStartedTask; hostSessionId?: string }) {
  const { t } = useTranslation();
  const title = useLinkedTaskTitle(task.sessionId, hostSessionId, task.title) || t('chat.botStartedTasks.untitled');
  const open = useOpenLinkedTask(task.sessionId, hostSessionId);
  const content = (
    <>
      <CornerDownRight size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-[var(--text-secondary)]" />
      <span className="min-w-0 truncate font-medium">{title}</span>
      {open ? <ChevronRight size={14} aria-hidden className="shrink-0 text-[var(--text-tertiary)]" /> : null}
    </>
  );
  if (!open) return <span className={cn(BOT_TASK_PILL_CLASS, 'max-w-[320px]')} title={title}>{content}</span>;
  return (
    <button
      type="button"
      data-split-pane-route-action=""
      title={t('chat.botStartedTasks.open', { title })}
      aria-label={t('chat.botStartedTasks.open', { title })}
      onClick={open}
      className={cn(BOT_TASK_PILL_CLASS, 'max-w-[320px]', CHAT_FOCUS_CLASS, CHAT_COLOR_TRANSITION_CLASS, 'hover:bg-[var(--cmd-palette-item-hover)]')}
    >
      {content}
    </button>
  );
}

function TaskLink({ task, hostSessionId }: { task: BotStartedTask; hostSessionId?: string }) {
  const { t } = useTranslation();
  const title = useLinkedTaskTitle(task.sessionId, hostSessionId, task.title) || t('chat.botStartedTasks.untitled');
  const open = useOpenLinkedTask(task.sessionId, hostSessionId);
  const label = t(task.created ? 'chat.botStartedTasks.startedOne' : 'chat.botStartedTasks.handedToOne');
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-13 leading-5 text-[var(--text-secondary)]">
      <CornerDownRight size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
      <span className="shrink-0">{label}</span>
      {open ? (
        <button type="button" data-split-pane-route-action="" onClick={open} title={t('chat.botStartedTasks.open', { title })}
          className={cn('inline-flex min-w-0 items-center gap-0.5 rounded-[4px] font-medium text-[var(--msg-assistant-text)] hover:underline', CHAT_FOCUS_CLASS)}>
          <span className="min-w-0 truncate">{title}</span>
          <ChevronRight size={14} aria-hidden className="shrink-0 text-[var(--text-tertiary)]" />
        </button>
      ) : <span className="min-w-0 truncate font-medium text-[var(--msg-assistant-text)]">{title}</span>}
    </div>
  );
}

/**
 * Foot of the reply bubble that started the tasks: one line per task, "↳ Started <task> ›", read as
 * the reply's last sentence rather than a separate card (owner's pick, 2026-11-10).
 */
export function BotStartedTasksFooter({ tasks, hostSessionId }: { tasks: readonly BotStartedTask[]; hostSessionId?: string }) {
  return (
    <div className="mt-2 flex flex-col gap-1" data-testid="bot-started-tasks">
      {tasks.map((task) => <TaskLink key={task.sessionId} task={task} hostSessionId={hostSessionId} />)}
    </div>
  );
}

/**
 * Moves each turn's started tasks into the reply that announced them; a turn without a reply
 * (still working, or only tool steps) keeps the standalone row.
 */
export function attachBotStartedTasks(items: RenderItem[]): RenderItem[] {
  const result: RenderItem[] = [];
  for (const item of items) {
    if (item.type !== 'bot_started_tasks') { result.push(item); continue; }
    let reply = -1;
    for (let index = result.length - 1; index >= 0; index -= 1) {
      const candidate = result[index]!;
      if (candidate.type === 'message' && candidate.message.role === 'user') break;
      if (candidate.type === 'message' && candidate.message.role === 'assistant' && candidate.message.content.trim()) { reply = index; break; }
    }
    if (reply < 0) { result.push(item); continue; }
    const target = result[reply] as Extract<RenderItem, { type: 'message' }>;
    result[reply] = { ...target, message: { ...target.message, botStartedTasks: item.tasks } };
  }
  return result;
}

/** Standalone row for a turn whose tasks have no reply to sit in. */
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

/**
 * A message another task sent into the teammate chat, folded to one pill in the same shape as the
 * task chips: which task wrote, and its first line. Opens to the full text (UserMessage owns that).
 */
export function BotTaskLetterPill({ senderSessionId, senderTitle, hostSessionId, preview, expanded, onToggle }: {
  senderSessionId?: string;
  senderTitle: string | null;
  hostSessionId?: string;
  preview: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const title = useLinkedTaskTitle(senderSessionId, hostSessionId, senderTitle) || t('chat.botStartedTasks.untitled');
  return (
    <button
      type="button"
      aria-expanded={expanded}
      title={t('chat.botTaskLetter.toggle', { title })}
      onClick={onToggle}
      className={cn(BOT_TASK_PILL_CLASS, CHAT_FOCUS_CLASS, CHAT_COLOR_TRANSITION_CLASS, 'hover:bg-[var(--cmd-palette-item-hover)]')}
    >
      <CornerDownLeft size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-[var(--text-secondary)]" />
      <span className="min-w-0 max-w-[45%] shrink-0 truncate font-medium">{title}</span>
      <span className="shrink-0 text-[var(--text-secondary)]">{t('chat.botTaskLetter.replied')}</span>
      {!expanded && preview ? <span className="min-w-0 truncate text-[var(--text-secondary)]">{preview}</span> : null}
      {expanded
        ? <ChevronDown size={14} aria-hidden className="shrink-0 text-[var(--text-tertiary)]" />
        : <ChevronRight size={14} aria-hidden className="shrink-0 text-[var(--text-tertiary)]" />}
    </button>
  );
}

/** Opens the task a letter came from, under the expanded text. */
export function BotTaskLetterOpen({ senderSessionId, hostSessionId }: { senderSessionId?: string; hostSessionId?: string }) {
  const { t } = useTranslation();
  const open = useOpenLinkedTask(senderSessionId, hostSessionId);
  if (!open) return null;
  return (
    <button type="button" data-split-pane-route-action="" onClick={open}
      className={cn('inline-flex items-center gap-0.5 rounded-[4px] text-13 text-[var(--text-secondary)] hover:text-[var(--msg-assistant-text)]', CHAT_FOCUS_CLASS, CHAT_COLOR_TRANSITION_CLASS)}>
      {t('chat.botTaskLetter.openTask')}
      <ChevronRight size={14} aria-hidden className="shrink-0" />
    </button>
  );
}
