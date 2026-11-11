import { additionalSettings } from './AdditionalSettings.settings-search';
import { useSettingDefinition } from './useSettingDefinition';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Copy, Folder, Info, MoreHorizontal, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SETTINGS_HINT, SettingsBlock, SettingsCard, SettingsRow } from '@/components/ui/settings-rows';
import { Tip } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { mapIpcErrorToI18nKey } from '@/utils/ipcError';
import type { DialogueWorkspaceSettingsState } from '../../../shared/dialogueWorkspaceSettings';
import { dialogueDirectoryDisplayParts } from './dialogueDirectoryDisplay';

export function DialogueDirectorySection() {
  const setting = useSettingDefinition(additionalSettings.dialogueDirectory);
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
    <SettingsCard {...setting.anchorProps}>
      <SettingsRow
        wrap
        title={<span role="heading" aria-level={3}>{setting.title}</span>}
        tag={state && <span className="rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-11 text-[var(--text-secondary)]">
          {t(state.isCustomized ? 'settings.defaults.customizedBadge' : 'settings.about.storage.dialogueDirectoryDefault')}
        </span>}
        hint={state && (
          <span className="flex min-w-0 items-center gap-1.5">
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
                  <Button {...setting.controlProps} variant="secondary" size="md" className="w-8 border-transparent bg-transparent px-0" aria-label={t('settings.about.storage.dialogueDirectoryFullPath')}>
                    <MoreHorizontal size={15} aria-hidden />
                  </Button>
                </Tip>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-[340px] max-w-[calc(100vw-32px)] rounded-xl border-[var(--border-default)] bg-[var(--surface-elevated)] p-4 text-[var(--text-primary)] shadow-none">
                <p className="mb-2 text-12 text-[var(--text-secondary)]">{t('settings.about.storage.dialogueDirectoryFullPath')}</p>
                <p className="select-text break-all font-mono text-12 leading-relaxed">{state.directory}</p>
                <p className="mt-2 text-12 leading-relaxed text-[var(--text-secondary)]">{t('settings.about.storage.dialogueDirectoryDetails')}</p>
                <Button {...setting.controlProps} variant="secondary" size="md" className="mt-3 gap-1.5" onClick={() => void copyPath()}>
                  <Copy size={14} aria-hidden />{t('settings.about.storage.dialogueDirectoryCopy')}
                </Button>
              </PopoverContent>
            </Popover>
          </span>
        )}
        trailing={
          <div className="flex shrink-0 items-center gap-2">
            {state?.isCustomized && (
              <Tip text={t('settings.about.storage.dialogueDirectoryReset')}>
                <Button {...setting.controlProps} variant="secondary" tone="quiet" size="sm" className="w-7 px-0" disabled={busy} aria-label={t('settings.about.storage.dialogueDirectoryReset')} onClick={() => void update('reset')}>
                  <RotateCcw size={15} aria-hidden />
                </Button>
              </Tip>
            )}
            <Button {...setting.controlProps} variant="secondary" size="md" className="gap-1.5" disabled={busy || !state} onClick={() => void openDirectory()}>
              <Folder size={14} aria-hidden />{t('settings.about.storage.dialogueDirectoryOpen')}
            </Button>
            <Button {...setting.controlProps} variant="secondary" size="md" className="gap-1.5" disabled={busy} onClick={() => void update('choose')}>
              {t('settings.about.storage.dialogueDirectoryChoose')}<ChevronRight size={14} aria-hidden />
            </Button>
          </div>
        }
      />
      <SettingsBlock>
        <p className={cn('flex items-start gap-1.5', SETTINGS_HINT)}>
          <Info size={13} className="mt-0.5 shrink-0" aria-hidden />{setting.description}
        </p>
      </SettingsBlock>
    </SettingsCard>
  );
}
