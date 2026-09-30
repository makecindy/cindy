import { cn } from '@/lib/utils';

// The existing delegation card's reading width and container, shared by its receipt.
export const BOT_TASK_CARD_CLASS =
  'my-2 w-full max-w-[560px] rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3 text-12';

export function BotTaskCardHeader({
  title,
  status,
  statusClass,
}: {
  title: string;
  status: string;
  statusClass: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div
        title={title}
        className="min-w-0 flex-1 line-clamp-2 break-words text-14 font-medium leading-5 text-[var(--text-primary)]"
      >
        {title}
      </div>
      <span className={cn('flex shrink-0 items-center gap-1.5 text-12 leading-5', statusClass)}>
        <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
        {status}
      </span>
    </div>
  );
}
