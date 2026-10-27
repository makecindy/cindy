/**
 * An independent task a teammate started from this group (bot-group-chat.md §10).
 *
 * My own teammate's task, when this computer is its home: the same background-task card as in
 * its chat (live status, result, files, 补一句), read from the delegation row here. Someone
 * else's teammate, or mine opened on another of my computers: the card as it was posted —
 * title and state — because that task runs on the companion's home computer.
 */
import { ListTodo } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BotGroupTaskCardView } from '../../../shared/botGroupChat';
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
        <span className="truncate text-13 font-medium leading-6 text-[var(--text-primary)]">{task.title}</span>
        <span className="min-w-0 break-words text-12 leading-5 text-[var(--text-tertiary)]">
          {task.state === 'waiting' && task.summary ? `${state} · ${task.summary}` : state}
        </span>
      </div>
    </div>
  );
}
