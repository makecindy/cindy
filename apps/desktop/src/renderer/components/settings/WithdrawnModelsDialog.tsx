/**
 * Review models that a complete refresh no longer found upstream (#11298).
 *
 * Refresh never deletes by itself: the user sees the exact list and removes only
 * what stays checked. When the result looks like a broken upstream response
 * (empty catalog, or at least half of the discovered models missing), nothing is
 * preselected and a warning asks the user to refresh again later.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';

import type { AgentKind } from '@cindy/model-providers';

import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

export interface WithdrawnModelCandidate {
  id: string;
  name: string;
  /** Runtimes whose complete catalog no longer lists this model. */
  agents: AgentKind[];
}

export interface WithdrawnModelsReview {
  providerId: string;
  providerName: string;
  models: WithdrawnModelCandidate[];
  suspicious: boolean;
}

export function WithdrawnModelsDialog({
  review,
  removing,
  onCancel,
  onRemove,
}: {
  review: WithdrawnModelsReview | null;
  removing: boolean;
  onCancel: () => void;
  onRemove: (modelIds: string[]) => void;
}) {
  const { t } = useTranslation();
  const listId = useId();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // The shared dialog's primary action also requests close; keep the list open
  // with its progress state until the caller finishes and clears the review.
  const confirmingRef = useRef(false);
  useEffect(() => {
    // Ordinary withdrawals are preselected; suspicious ones need an explicit choice.
    // Keep the last selection while closing so the button label does not flash.
    if (review) setSelected(new Set(review.suspicious ? [] : review.models.map((model) => model.id)));
  }, [review]);
  // Keep the last review rendered while the dialog plays its close animation.
  const shownRef = useRef<WithdrawnModelsReview | null>(null);
  if (review) shownRef.current = review;
  const shown = review ?? shownRef.current;
  const models = shown?.models ?? [];
  const allSelected = models.length > 0 && selected.size === models.length;
  const toggle = (id: string, checked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  return (
    <ConfirmDialog
      open={review !== null}
      onOpenChange={(open) => {
        if (open) return;
        if (confirmingRef.current) {
          confirmingRef.current = false;
          return;
        }
        if (!removing) onCancel();
      }}
      title={t('settings.providers.models.withdrawn.heading', { count: models.length })}
      description={t('settings.providers.models.withdrawn.intro', {
        provider: shown?.providerName ?? '',
      })}
      maxWidth={460}
      contentSelectable
      loading={removing}
      confirmVariant="destructive"
      confirmDisabled={selected.size === 0}
      confirmText={t('settings.providers.models.withdrawn.confirm', { count: selected.size })}
      cancelText={t('settings.providers.models.withdrawn.cancel')}
      onConfirm={() => {
        confirmingRef.current = true;
        onRemove(models.filter((model) => selected.has(model.id)).map((model) => model.id));
      }}
      content={
        <div className="mt-3 flex flex-col gap-3">
          {shown?.suspicious && (
            <div
              role="note"
              className="flex items-start gap-2 rounded-xl border border-[var(--border-default)] p-3 text-13 text-[var(--text-primary)]"
            >
              <AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0 text-[var(--warning-fg)]" />
              <span>{t('settings.providers.models.withdrawn.suspicious')}</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-2 text-13 text-[var(--text-secondary)]">
            <span>{t('settings.providers.models.withdrawn.selected', { count: selected.size, total: models.length })}</span>
            <label className="flex min-h-8 cursor-pointer items-center gap-2">
              <Checkbox
                data-settings-search-action="Select every withdrawn model in the removal review dialog"
                aria-controls={listId}
                checked={allSelected}
                indeterminate={selected.size > 0 && !allSelected}
                disabled={removing}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setSelected(new Set(checked ? models.map((model) => model.id) : []));
                }}
              />
              {t('settings.providers.models.withdrawn.selectAll')}
            </label>
          </div>
          <ul id={listId} className="flex flex-col border-y border-[var(--border-default)] py-1">
            {models.map((model) => (
              <li key={model.id}>
                <label className="flex min-h-9 cursor-pointer items-center gap-3 rounded-lg px-1 py-1.5 hover:bg-[var(--surface-hover)]">
                  <Checkbox
                    data-settings-search-action="Choose whether this withdrawn model is removed from the connection"
                    checked={selected.has(model.id)}
                    disabled={removing}
                    onChange={(event) => toggle(model.id, event.currentTarget.checked)}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="break-words text-13 text-[var(--text-primary)]">{model.name}</span>
                    {model.name !== model.id && (
                      <span className="break-all text-12 text-[var(--text-tertiary)]">{model.id}</span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <p className="text-12 text-[var(--text-secondary)]">{t('settings.providers.models.withdrawn.consequence')}</p>
        </div>
      }
    />
  );
}
