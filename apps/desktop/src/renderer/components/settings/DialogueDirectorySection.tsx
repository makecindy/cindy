import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Copy, Folder, Info, MoreHorizontal, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tip } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import { mapIpcErrorToI18nKey } from '@/utils/ipcError';
import type { DialogueWorkspaceSettingsState } from '../../../shared/dialogueWorkspaceSettings';
import { dialogueDirectoryDisplayParts } from './dialogueDirectoryDisplay';

export function DialogueDirectorySection() {
  const { t } = useTranslation();
  const [state, setState] = useState<DialogueWorkspaceSettingsState | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const revision = useRef(0);
  const api = window.electronAPI.dialogueWorkspace;

  useEffect(() => {
    if (!api) return;
    let active = true;
    const request = ++revision.current;
    void api.get().then((value) => { if (active && request === revision.current) setState(value); }).catch((error) => {
      if (active) toast.error(t(mapIpcErrorToI18nKey(error, { fallback: 'settings.about.storage.dialogueDirectoryFailed' })));
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
      toast.error(t(mapIpcErrorToI18nKey(error, { fallback: 'settings.about.storage.dialogueDirectoryFailed' })));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const copyPath = async () => {
    if (!state) return;
    try {
      await navigator.clipboard.writeText(state.directory);
      toast.success(t('settings.about.storage.dialogueDirectoryCopied'));
    } catch {
      toast.error(t('settings.about.storage.dialogueDirectoryCopyFailed'));
    }
  };

  const openDirectory = async () => {
    if (!state) return;
    try {
      const result = await api.open();
      if (!result.success) toast.error(t('ccAgent.common.openFolderFailed'));
    } catch {
      toast.error(t('ccAgent.common.openFolderFailed'));
    }
  };

  if (!api) return null;
  return (
    <div className="rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] px-[18px] py-4">
      <div className="flex min-h-[64px] flex-wrap items-center justify-between gap-x-5 gap-y-3">
        <div className="min-w-0 max-w-full">
          <div className="flex items-center gap-2">
            <h3 className="text-13 font-medium text-[var(--settings-section-title)]">
              {t('settings.about.storage.dialogueDirectoryTitle')}
            </h3>
            {state && <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-11 text-[var(--text-secondary)]">
              {t(state.isCustomized ? 'settings.defaults.customizedBadge' : 'settings.about.storage.dialogueDirectoryDefault')}
            </span>}
          </div>
          {state && (
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-12 text-[var(--text-secondary)]">
              <Folder size={15} className="shrink-0" aria-hidden />
              {dialogueDirectoryDisplayParts(state.directory, window.electronAPI.platform).map((part, index) => (
                <span key={index} className="flex min-w-0 items-center gap-1.5">
                  {index > 0 && <ChevronRight size={12} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden />}
                  <span className="max-w-[180px] truncate">{part}</span>
                </span>
              ))}
              <Popover>
                <PopoverTrigger asChild>
                  <Tip text={t('settings.about.storage.dialogueDirectoryFullPath')}>
                    <Button variant="secondary" size="md" className="w-8 border-transparent bg-transparent px-0" aria-label={t('settings.about.storage.dialogueDirectoryFullPath')}>
                      <MoreHorizontal size={15} aria-hidden />
                    </Button>
                  </Tip>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-[340px] max-w-[calc(100vw-32px)] rounded-xl border-[var(--border-default)] bg-[var(--surface-elevated)] p-4 text-[var(--text-primary)] shadow-none">
                  <p className="mb-2 text-12 text-[var(--text-secondary)]">{t('settings.about.storage.dialogueDirectoryFullPath')}</p>
                  <p className="select-text break-all font-mono text-12 leading-relaxed">{state.directory}</p>
                  <p className="mt-2 text-12 leading-relaxed text-[var(--text-secondary)]">{t('settings.about.storage.dialogueDirectoryDetails')}</p>
                  <Button variant="secondary" size="md" className="mt-3 gap-1.5" onClick={() => void copyPath()}>
                    <Copy size={14} aria-hidden />{t('settings.about.storage.dialogueDirectoryCopy')}
                  </Button>
                </PopoverContent>
              </Popover>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {state?.isCustomized && (
            <Tip text={t('settings.about.storage.dialogueDirectoryReset')}>
              <Button variant="secondary" size="md" className="w-8 border-transparent bg-transparent px-0" disabled={busy} aria-label={t('settings.about.storage.dialogueDirectoryReset')} onClick={() => void update('reset')}>
                <RotateCcw size={15} aria-hidden />
              </Button>
            </Tip>
          )}
          <Button variant="secondary" size="md" className="gap-1.5" disabled={busy || !state} onClick={() => void openDirectory()}>
            <Folder size={14} aria-hidden />{t('settings.about.storage.dialogueDirectoryOpen')}
          </Button>
          <Button variant="secondary" size="md" className="gap-1.5" disabled={busy} onClick={() => void update('choose')}>
            {t('settings.about.storage.dialogueDirectoryChoose')}<ChevronRight size={14} aria-hidden />
          </Button>
        </div>
      </div>
      <p className="mt-3 flex items-start gap-1.5 border-t border-[var(--settings-theme-card-border)] pt-3 text-12 leading-relaxed text-[var(--settings-section-desc)]">
        <Info size={13} className="mt-0.5 shrink-0" aria-hidden />{t('settings.about.storage.dialogueDirectoryDescription')}
      </p>
    </div>
  );
}
