import type { ReactNode } from 'react';
import { BookOpen, Brain } from 'lucide-react';
import { useInRouterContext, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { botLearningRows, type BotLearningReceipt } from '@cindy/maker-shared/bot-learning';
import { CHAT_BUBBLE_COLUMN_CLASS } from '@/components/chat/ChatBubble';
import { memoryEntriesRoute } from '@/components/settings/memoryEntriesRoute';
import { cn } from '@/lib/utils';
import type { MakerMemoryTaskLocation } from '../../../shared/makerMemoryEntries';

/**
 * Where the reply was written, which decides what a row opens:
 * - `teammate`: the teammate's settings drawer (memory page / capabilities page);
 * - `task`: an ordinary task whose Cindy memory is on this computer — the memory row opens the
 *   saved memories page in Settings: on “About you”, or on the task's project when the receipt
 *   says the project memory was written (`task` tells the page which task that is);
 * - `task-readonly`: an ordinary task on another computer (remote control, shared task) — that
 *   computer's memory has no page here, so the row is plain text.
 * Ordinary tasks only ever save memory; a Skill row is a teammate row.
 */
export type LearningFooterSurface = 'teammate' | 'task' | 'task-readonly';

const ROW_CLASS = 'flex min-h-7 max-w-full items-center gap-2 text-left text-12 text-[var(--text-tertiary)]';

/**
 * Save receipt under the reply that wrote memory (or, for a teammate, a Skill).
 * Only mounted below its own assistant content; opens existing pages, never a new detail UI.
 * Several saves join into one row, so the footer takes the bubble column width and lets the row truncate.
 */
export function BotLearningFooter({
  receipts,
  surface = 'teammate',
  task,
}: {
  receipts: unknown;
  surface?: LearningFooterSurface;
  /** Ordinary tasks: where the task runs, so a project receipt opens that project's memory. */
  task?: MakerMemoryTaskLocation;
}) {
  const { t } = useTranslation();
  // Message lists are also rendered where there is nowhere to navigate to; the receipt is then text.
  const canOpen = useInRouterContext() && surface !== 'task-readonly';
  const rows = botLearningRows(receipts);
  const items = surface === 'teammate' ? rows : rows.filter((item) => item.kind === 'memory');
  if (!items.length) return null;
  return (
    <div className={cn('mt-2 flex w-full min-w-0 flex-col items-start gap-1', CHAT_BUBBLE_COLUMN_CLASS)} data-bot-learning-footer>
      {items.map((item) => {
        const Icon = item.kind === 'memory' ? Brain : BookOpen;
        const label = t(
          `bots.learning.${item.kind === 'memory' ? 'memory' : item.action === 'created' ? 'skillCreated' : 'skillUpdated'}`,
          { title: item.title },
        );
        const icon = <Icon size={13} className="shrink-0" aria-hidden />;
        return canOpen ? (
          <OpenRow key={`${item.kind}:${item.key}`} item={item} surface={surface} task={task}>
            {icon}
            <span className="min-w-0 truncate underline underline-offset-4" title={label}>
              {label}
            </span>
          </OpenRow>
        ) : (
          <p key={`${item.kind}:${item.key}`} className={ROW_CLASS}>
            {icon}
            <span className="min-w-0 truncate" title={label}>
              {label}
            </span>
          </p>
        );
      })}
    </div>
  );
}

/** A receipt row that opens the page where the saved entry can be seen and edited. */
function OpenRow({
  item,
  surface,
  task,
  children,
}: {
  item: BotLearningReceipt;
  surface: LearningFooterSurface;
  task?: MakerMemoryTaskLocation;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  return (
    <button
      type="button"
      className={cn(ROW_CLASS, 'hover:text-[var(--text-secondary)]')}
      onClick={() => {
        if (surface === 'task') {
          navigate(memoryEntriesRoute(item.scope === 'project' ? task : null));
          return;
        }
        setSearchParams((current) => {
          const next = new URLSearchParams(current);
          next.set('settings', '1');
          next.set('settingsPage', item.kind === 'memory' ? 'memory' : 'capabilities');
          return next;
        });
      }}
    >
      {children}
    </button>
  );
}
