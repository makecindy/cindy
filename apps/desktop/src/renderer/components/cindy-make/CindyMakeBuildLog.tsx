import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CindyMakePersonalBuildState } from '../../../shared/cindyMakeSession';

/** A compact, localizable timeline of build stages; it deliberately omits raw process output. */
export function CindyMakeBuildLog({
  build,
  openWhileActive = false,
}: {
  build?: CindyMakePersonalBuildState;
  openWhileActive?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const entries = build?.logs ?? [];
  const [open, setOpen] = useState(openWhileActive);
  useEffect(() => {
    if (openWhileActive) setOpen(true);
  }, [openWhileActive]);
  if (!entries.length) return null;
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-card)] px-3 py-2"
    >
      <summary className="flex min-h-8 cursor-pointer select-none items-center text-12 font-medium text-[var(--text-secondary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
        {t('cindyMake.personal.buildLog.title')} · {entries.length}
      </summary>
      <ol className="mt-2 max-h-40 space-y-1 overflow-y-auto border-t border-[var(--border-default)] pt-2 text-12">
        {entries.map((entry, index) => (
          <li
            key={entry.step + '-' + entry.at + '-' + index}
            className="flex gap-2 text-[var(--text-secondary)]"
          >
            <time
              dateTime={new Date(entry.at).toISOString()}
              className="shrink-0 text-[var(--text-tertiary)]"
            >
              {new Intl.DateTimeFormat(i18n.resolvedLanguage ?? i18n.language, {
                timeStyle: 'medium',
              }).format(entry.at)}
            </time>
            <span>{t('cindyMake.personal.buildLog.steps.' + entry.step)}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
