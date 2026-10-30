import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Trash2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';
import { deleteVoiceInputDictionaryEntries } from '@/hooks/useVoiceInputSettings';

type DictionaryToastEntry = {
  entryId: string;
  term: string;
};

function parseDictionaryToastEntries(params: URLSearchParams): DictionaryToastEntry[] {
  const entriesParam = params.get('entries');
  if (entriesParam) {
    try {
      const parsed = JSON.parse(entriesParam);
      if (Array.isArray(parsed)) {
        return parsed
          .map((entry) => {
            if (!entry || typeof entry !== 'object') return null;
            const candidate = entry as { entryId?: unknown; term?: unknown };
            const entryId = typeof candidate.entryId === 'string' ? candidate.entryId.trim() : '';
            const term = typeof candidate.term === 'string' ? candidate.term.trim() : '';
            return entryId && term ? { entryId, term } : null;
          })
          .filter((entry): entry is DictionaryToastEntry => Boolean(entry));
      }
    } catch {
      // Fall through to the legacy single-entry query shape.
    }
  }

  const entryId = params.get('entryId')?.trim() ?? '';
  const term = params.get('term')?.trim() ?? '';
  return entryId && term ? [{ entryId, term }] : [];
}

export function VoiceInputDictionaryToast() {
  const { t } = useTranslation();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const entries = useMemo(() => parseDictionaryToastEntries(params), [params]);
  const terms = entries.map((entry) => entry.term);
  const termText = useMemo(() => {
    if (terms.length === 0) return t('settings.voiceInput.refinement.dictionary.label');
    const visibleTerms = terms.slice(0, 3).join('、');
    if (terms.length <= 3) return visibleTerms;
    return t('settings.voiceInput.refinement.dictionary.toast.termsSummary', {
      terms: visibleTerms,
      count: terms.length,
    });
  }, [t, terms]);
  const title = t('settings.voiceInput.refinement.dictionary.toast.title');

  const close = useCallback(() => {
    void window.electronAPI.voiceInput.closeDictionaryToast();
  }, []);

  const deleteEntry = useCallback(() => {
    deleteVoiceInputDictionaryEntries(entries.map((entry) => entry.entryId));
    close();
  }, [close, entries]);

  return (
    <div className="flex h-screen w-screen select-none items-center justify-center bg-transparent p-[34px] text-[var(--cmd-palette-item-text)]">
      <div
        className={cn(
          'flex h-11 w-max max-w-full shrink-0 items-center gap-2 rounded-xl border px-2.5',
          'border-[var(--cmd-palette-border)] shadow-[var(--shadow-menu)] backdrop-blur-xl',
        )}
        style={{ backgroundColor: 'color-mix(in srgb, var(--cmd-palette-bg) 95%, transparent)' }}
      >
        <div className="grid h-6 w-5 shrink-0 place-items-center text-[var(--cmd-palette-item-meta)]">
          <Sparkles aria-hidden className="h-4 w-4" strokeWidth={2.2} />
        </div>
        <div className="flex min-w-0 shrink items-center gap-2">
          <div className="shrink-0 whitespace-nowrap text-12 font-medium leading-5 text-[var(--cmd-palette-item-meta)]">
            {title}
          </div>
          <div className="min-w-0 truncate text-14 font-semibold leading-5 text-[var(--cmd-palette-item-text)]">
            {termText}
          </div>
        </div>
        <Tip text={t('settings.voiceInput.refinement.dictionary.toast.delete')}>
          <button
            type="button"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[var(--cmd-palette-item-meta)] transition hover:bg-[var(--cmd-palette-item-hover)] hover:text-[var(--cmd-palette-item-text)] active:scale-95"
            aria-label={t('settings.voiceInput.refinement.dictionary.toast.deleteAriaLabel', {
              term: termText,
            })}
            onMouseDown={(event) => event.preventDefault()}
            onClick={deleteEntry}
          >
            <Trash2 aria-hidden className="h-4 w-4" strokeWidth={2} />
          </button>
        </Tip>
      </div>
    </div>
  );
}
