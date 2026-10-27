import { Spinner } from '@/components/ui/spinner';
import { useBotTranslation } from './botPronounContext';

/** Same line and spinner as the invitation welcome, shown inside the open chat while the first hello is composed. */
export function BotOpeningPending({ name, bottomInset }: { name: string; bottomInset: number }) {
  const { t } = useBotTranslation();
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-center px-6"
      style={{ bottom: bottomInset }}
    >
      <p
        className="flex items-center gap-2 text-13 text-[var(--text-secondary)]"
        role="status"
        aria-live="polite"
      >
        <Spinner size={15} />
        {t('bots.invitation.welcome', { name })}
      </p>
    </div>
  );
}
