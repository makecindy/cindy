import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Folder, Info, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import { mapIpcErrorToI18nKey } from '@/utils/ipcError';
import type { ProjectsRootState } from '../../../shared/projectsRoot';

const SOURCE_BADGE_KEYS: Record<ProjectsRootState['source'], string> = {
  setting: 'settings.defaults.customizedBadge',
  inferred: 'settings.about.storage.projectsRootInferred',
  default: 'settings.about.storage.projectsRootDefault',
};

/** Where "New project…" puts project folders. Unset follows the suggestion; nothing default is stored. */
export function ProjectsRootSection() {
  const { t } = useTranslation();
  const [state, setState] = useState<ProjectsRootState | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const revision = useRef(0);
  const api = window.electronAPI.projectsRoot;

  useEffect(() => {
    if (!api) return;
    let active = true;
    const request = ++revision.current;
    void api.get().then((value) => { if (active && request === revision.current) setState(value); }).catch((error) => {
      if (active) toast.error(t(mapIpcErrorToI18nKey(error, { fallback: 'settings.about.storage.projectsRootFailed' })));
    });
    return () => { active = false; revision.current++; };
  }, [api, t]);

  const update = async (action: 'choose' | 'reset') => {
    if (pending.current) return;
    pending.current = true;
    const request = ++revision.current;
    setBusy(true);
    try {
      const value = await api[action]();
      if (request === revision.current) setState(value);
    } catch (error) {
      toast.error(t(mapIpcErrorToI18nKey(error, { fallback: 'settings.about.storage.projectsRootFailed' })));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  if (!api) return null;
  return (
    <div className="rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] px-[18px] py-4">
      <div className="flex min-h-[64px] flex-wrap items-center justify-between gap-x-5 gap-y-3">
        <div className="min-w-0 max-w-full">
          <div className="flex items-center gap-2">
            <h3 className="text-13 font-medium text-[var(--settings-section-title)]">
              {t('settings.about.storage.projectsRootTitle')}
            </h3>
            {state && <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-11 text-[var(--text-secondary)]">
              {t(SOURCE_BADGE_KEYS[state.source])}
            </span>}
          </div>
          {state && (
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-12 text-[var(--text-secondary)]" title={state.path}>
              <Folder size={15} className="shrink-0" aria-hidden />
              <span className="min-w-0 select-text truncate">{state.path}</span>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {state?.source === 'setting' && (
            <Tip text={t('settings.about.storage.projectsRootReset')}>
              <Button variant="secondary" size="md" className="w-8 border-transparent bg-transparent px-0" disabled={busy} aria-label={t('settings.about.storage.projectsRootReset')} onClick={() => void update('reset')}>
                <RotateCcw size={15} aria-hidden />
              </Button>
            </Tip>
          )}
          <Button variant="secondary" size="md" className="gap-1.5" disabled={busy} onClick={() => void update('choose')}>
            {t('settings.about.storage.projectsRootChoose')}<ChevronRight size={14} aria-hidden />
          </Button>
        </div>
      </div>
      <p className="mt-3 flex items-start gap-1.5 border-t border-[var(--settings-theme-card-border)] pt-3 text-12 leading-relaxed text-[var(--settings-section-desc)]">
        <Info size={13} className="mt-0.5 shrink-0" aria-hidden />{t('settings.about.storage.projectsRootDescription')}
      </p>
    </div>
  );
}
