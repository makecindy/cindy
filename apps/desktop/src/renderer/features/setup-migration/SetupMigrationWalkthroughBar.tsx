/**
 * "Go through the list" bar (docs/product-rules/new-device-setup-migration.md): after a setup,
 * the one-time checklist (sign-ins, keys, permissions) is walked item by item. Each step opens the
 * item's own Settings page; an item this computer can recognize as finished moves on by itself,
 * the others are confirmed with "Done, next". Nothing here signs in or stores anything.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ListChecks, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { SetupMigrationChecklistItem } from '../../../shared/setupMigration';
import { checklistItemTitle } from './SetupMigrationChecklist';
import { openChecklistRoute } from './checklistTargets';
import {
  advanceSetupMigrationWalkthrough,
  getSetupMigrationWalkthrough,
  notifySetupMigrationStateChanged,
  stopSetupMigrationWalkthrough,
  subscribeSetupMigrationStateChanged,
  useSetupMigrationWalkthrough,
} from './setupMigrationStore';

const REFRESH_MS = 4000;
const AUTO_NEXT_MS = 1200;
const FINISHED_CLOSE_MS = 4000;

/** Next item to open after moving past the current one, or null when the list is finished. */
export function nextWalkthroughItem(
  items: readonly SetupMigrationChecklistItem[],
): SetupMigrationChecklistItem | null {
  const doneIds = new Set(items.filter((item) => item.done).map((item) => item.id));
  advanceSetupMigrationWalkthrough((id) => doneIds.has(id));
  const state = getSetupMigrationWalkthrough();
  if (!state || state.index >= state.ids.length) return null;
  return items.find((item) => item.id === state.ids[state.index]) ?? null;
}

export function SetupMigrationWalkthroughBar() {
  const { t } = useTranslation();
  const walk = useSetupMigrationWalkthrough();
  const [items, setItems] = useState<SetupMigrationChecklistItem[]>([]);
  const advancing = useRef(false);
  const active = walk !== null;

  const refresh = useCallback(() => {
    const api = window.electronAPI?.setupMigration;
    if (!api) return;
    api
      .state()
      .then((state) => setItems(state.lastRun?.checklist ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!active) return;
    refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    const unsubscribe = subscribeSetupMigrationStateChanged(refresh);
    return () => {
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [active, refresh]);

  const finished = walk !== null && walk.index >= walk.ids.length;
  const current = useMemo(
    () => (walk && !finished ? items.find((item) => item.id === walk.ids[walk.index]) : undefined),
    [finished, items, walk],
  );

  const goNext = useCallback(() => {
    if (advancing.current) return;
    advancing.current = true;
    try {
      const next = nextWalkthroughItem(items);
      if (next) openChecklistRoute(next);
    } finally {
      advancing.current = false;
    }
  }, [items]);

  const markDoneAndNext = () => {
    if (!current) return;
    const api = window.electronAPI?.setupMigration;
    const doneItems = items.map((item) => (item.id === current.id ? { ...item, done: true } : item));
    setItems(doneItems);
    void api
      ?.dismiss({ kind: 'checklist-item', id: current.id })
      .then(() => notifySetupMigrationStateChanged())
      .catch(() => {});
    const next = nextWalkthroughItem(doneItems);
    if (next) openChecklistRoute(next);
  };

  // Finished here (a key saved, an account connected): move on by itself.
  useEffect(() => {
    if (!current?.done) return;
    const timer = window.setTimeout(goNext, AUTO_NEXT_MS);
    return () => window.clearTimeout(timer);
  }, [current?.done, goNext]);

  useEffect(() => {
    if (!finished) return;
    const timer = window.setTimeout(stopSetupMigrationWalkthrough, FINISHED_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [finished]);

  if (!walk) return null;
  const position = Math.min(walk.index + 1, walk.ids.length);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex justify-center px-4">
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-auto flex w-full max-w-[640px] items-center gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-2.5 text-[var(--text-primary)] shadow-[var(--shadow-menu)]"
      >
        {finished ? (
          <Check size={16} aria-hidden="true" className="shrink-0 text-[var(--status-success)]" />
        ) : (
          <ListChecks size={16} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-[var(--text-secondary)]" />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-12 text-[var(--text-secondary)]">
            {finished
              ? t('setupMigration.walkthrough.allDone')
              : t('setupMigration.walkthrough.progress', { current: position, total: walk.ids.length })}
          </span>
          {current ? (
            <span className="truncate text-13 font-medium">
              {checklistItemTitle(t, current)}
              {current.done ? (
                <span className="ml-2 text-12 font-normal text-[var(--status-success)]">
                  {t('setupMigration.checklist.done')}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
        {current && !current.done ? (
          <span className="flex shrink-0 items-center gap-2">
            <Button variant="secondary" size="sm" tone="quiet" compact onClick={() => openChecklistRoute(current)}>
              {t('setupMigration.walkthrough.open')}
            </Button>
            <Button variant="secondary" size="sm" tone="quiet" compact onClick={goNext}>
              {t('setupMigration.walkthrough.skip')}
            </Button>
            <Button variant="secondary" size="sm" compact onClick={markDoneAndNext}>
              {t('setupMigration.walkthrough.next')}
            </Button>
          </span>
        ) : null}
        <button
          type="button"
          onClick={stopSetupMigrationWalkthrough}
          aria-label={t('setupMigration.walkthrough.stop')}
          title={t('setupMigration.walkthrough.stop')}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
