import { BookOpen, Brain } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { botLearningRows } from '@cindy/maker-shared/bot-learning';
import { CHAT_BUBBLE_COLUMN_CLASS } from '@/components/chat/ChatBubble';
import { cn } from '@/lib/utils';

/**
 * Only mounted below its own assistant content; uses the existing teammate settings drawer.
 * Several saves join into one row, so the footer takes the bubble column width and lets the row truncate.
 */
export function BotLearningFooter({ receipts }: { receipts: unknown }) {
  const { t } = useTranslation();
  const [, setSearchParams] = useSearchParams();
  const items = botLearningRows(receipts);
  if (!items.length) return null;
  return (
    <div className={cn('mt-2 flex w-full min-w-0 flex-col items-start gap-1', CHAT_BUBBLE_COLUMN_CLASS)} data-bot-learning-footer>
      {items.map((item) => {
        const Icon = item.kind === 'memory' ? Brain : BookOpen;
        const label = t(
          `bots.learning.${item.kind === 'memory' ? 'memory' : item.action === 'created' ? 'skillCreated' : 'skillUpdated'}`,
          { title: item.title },
        );
        return (
          <button
            key={`${item.kind}:${item.key}`}
            type="button"
            className="flex min-h-7 max-w-full items-center gap-2 text-left text-12 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
            onClick={() =>
              setSearchParams((current) => {
                const next = new URLSearchParams(current);
                next.set('settings', '1');
                next.set('settingsPage', item.kind === 'memory' ? 'memory' : 'capabilities');
                return next;
              })
            }
          >
            <Icon size={13} className="shrink-0" aria-hidden />
            <span className="min-w-0 truncate underline underline-offset-4" title={label}>
              {label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
