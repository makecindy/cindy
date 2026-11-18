/**
 * An independent task a teammate started from this group (bot-group-chat.md §10).
 *
 * My own teammate's task, when this computer is its home: the same background-task card as in
 * its chat (live status, result, files, 补一句), read from the delegation row here. Someone
 * else's teammate, or mine opened on another of my computers: the card as it was posted —
 * title and state — because that task runs on the companion's home computer.
 */
import { ArrowUpRight, ListTodo } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { resolveSessionRoute } from '@/lib/orcaSessionIdentity';
import type { BotGroupMessageView, BotGroupTaskCardView } from '../../../shared/botGroupChat';
import { BotTaskCard } from './BotCollaborationCard';
import { useBotProfiles } from './botStore';
import { companionRunsHere } from './companionCloudPresentation';
import { useCompanionCloud } from './companionCloudStore';

export function BotGroupTaskCard({ task, owned, botId }: { task: BotGroupTaskCardView; owned: boolean; botId: string | null }) {
  const { t } = useTranslation();
  const profiles = useBotProfiles();
  const cloud = useCompanionCloud();
  if (owned && botId !== null && companionRunsHere(cloud, profiles.map((bot) => bot.id), botId)) {
    return (
      <div data-testid="bot-group-task" data-state={task.state} className="min-w-0 max-w-full">
        <BotTaskCard card={task.meta} sessionId={task.meta.parentSessionId ?? undefined} inset />
      </div>
    );
  }
  const state = t(`bots.groupChat.task.state.${task.state}`);
  return (
    <div
      data-testid="bot-group-task"
      data-state={task.state}
      className="flex w-fit min-w-0 max-w-full items-start gap-2.5 rounded-lg bg-[var(--surface)] px-3 py-2"
    >
      <ListTodo size={14} aria-hidden className="mt-[5px] shrink-0 text-[var(--text-tertiary)]" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span title={task.title} className="truncate text-13 font-medium leading-6 text-[var(--text-primary)]">{task.title}</span>
        <span className="min-w-0 break-words text-12 leading-5 text-[var(--text-tertiary)]">
          {task.state === 'waiting' && task.summary ? `${state} · ${task.summary}` : state}
        </span>
      </div>
    </div>
  );
}

/**
 * An ordinary task a teammate opened from this group (bot-group-chat.md §10, card revision 2): title,
 * who asked, the task's state and where it stopped, as the teammate's owner's computer last posted it. That owner opens
 * the task itself (here, or on the computer that runs it); other members see the card only.
 */
export function BotGroupLiveTaskCard({ task }: { task: NonNullable<BotGroupMessageView['liveTask']> }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const state = t(`bots.groupChat.task.live.${task.state}`);
  const asked = task.requesterName ? t('bots.groupChat.task.askedBy', { requester: task.requesterName }) : '';
  // Where the task stopped follows its state on the same line, cut at the card's edge.
  const status = [asked, state, task.summary].filter(Boolean).join(' · ');
  const open = () => {
    if (!task.here && task.deviceId) remoteProjectsStore.pinSessionOrigin(task.deviceId, task.taskId);
    void resolveSessionRoute(task.taskId, undefined, task.here ? undefined : { remote: true }).then(route => navigate(route));
  };
  const body = <>
    <ListTodo size={14} aria-hidden className="mt-[5px] shrink-0 text-[var(--text-tertiary)]" />
    <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
      <span className="truncate text-13 font-medium leading-[1.846] text-[var(--text-primary)]">{task.title || t('bots.groupChat.task.untitled')}</span>
      <span title={status} className="min-w-0 truncate text-12 leading-[1.667] text-[var(--text-tertiary)]">{status}</span>
    </span>
  </>;
  const pr = task.prUrl ? <button type="button" onClick={() => void window.electronAPI.openExternal(task.prUrl!)}
    className="mt-0.5 flex h-6 shrink-0 items-center gap-0.5 rounded-lg px-1.5 text-12 font-medium text-[var(--text-secondary)] outline-none hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
    {t('bots.groupChat.task.pr', { number: task.prUrl.split('/').pop() })}<ArrowUpRight size={12} aria-hidden />
  </button> : null;
  return (
    <div data-testid="bot-group-live-task" data-state={task.state}
      className="flex w-fit min-w-0 max-w-full items-start gap-1 rounded-lg bg-[var(--surface)]">
      {task.openable ? (
        <button type="button" onClick={open} aria-label={t('bots.groupChat.task.open', { title: task.title })}
          className="flex min-w-0 flex-1 items-start gap-2.5 rounded-lg px-3 py-2 outline-none hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
          {body}
        </button>
      ) : <div className="flex min-w-0 flex-1 items-start gap-2.5 px-3 py-2">{body}</div>}
      {pr && <span className="py-1.5 pr-1.5">{pr}</span>}
    </div>
  );
}
