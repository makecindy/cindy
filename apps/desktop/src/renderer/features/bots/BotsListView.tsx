import { useTranslation } from 'react-i18next';

/**
 * The shared sidebar already shows the teammates section. Leave the content pane
 * unselected here (e.g. after closing a paused teammate's settings): /bots selects
 * Cindy and /bots/roster opens the creation dialog.
 */
export function BotsListView() {
  const { t } = useTranslation();

  return (
    <main className="flex h-full items-center justify-center p-6">
      <p className="text-center text-14 leading-[1.43] text-[var(--text-tertiary)]">
        {t('bots.list.selectChat')}
      </p>
    </main>
  );
}
