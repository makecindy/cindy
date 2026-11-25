/** Team publishes started from the UI that are in progress or finished but not yet dismissed. */
import { CircleAlert, CircleCheck, LoaderCircle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useTeamPublishProgress } from '@/contexts/TeamPublishProgressContext';

const copy = 'settings.ghosts.publish.progress';

export function TeamPublishResults() {
  const { t } = useTranslation();
  const { entries, dismiss } = useTeamPublishProgress();
  if (entries.length === 0) return null;
  return (
    <section aria-label={t(`${copy}.title`)} className="mb-5">
      <ul className="space-y-1">
        {entries.map((entry) => {
          const Icon = entry.state === 'active' ? LoaderCircle : entry.state === 'succeeded' ? CircleCheck : CircleAlert;
          return (
            <li key={entry.transferId} role="status"
              className="flex min-w-0 items-center gap-2 text-13 leading-[1.54] text-[var(--text-secondary)]">
              {/* The spin lives on a wrapper, never on the SVG itself (engineering conventions §7). */}
              <span aria-hidden="true"
                className={`inline-flex shrink-0 text-[var(--text-tertiary)] ${entry.state === 'active' ? 'animate-spin motion-reduce:animate-none' : ''}`}>
                <Icon size={14} />
              </span>
              <span className="min-w-0 flex-1 break-words">{t(`${copy}.${entry.messageKey}`, entry.args)}</span>
              {entry.state === 'active' ? null : (
                <button
                  type="button"
                  aria-label={t(`${copy}.dismiss`)}
                  onClick={() => dismiss(entry.transferId)}
                  className="flex size-6 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
