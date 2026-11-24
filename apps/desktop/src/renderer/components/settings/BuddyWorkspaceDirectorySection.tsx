import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderInput, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SettingsCard } from '@/components/ui/settings-rows';
import { Tip } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { mapIpcErrorToI18nKey } from '@/utils/ipcError';
import type { BuddyWorkspaceSettingsState } from '../../../shared/buddyWorkspaceSettings';
import { additionalSettings } from './AdditionalSettings.settings-search';
import { useSettingDefinition } from './useSettingDefinition';
import { WorkspacePathField } from './WorkspacePathField';

/**
 * Default parent folder for brand-new buddies' workspaces (decoupled from Cindy's app data).
 * Existing buddies keep their current location and can be moved individually in their
 * Advanced configuration.
 */
export function BuddyWorkspaceDirectorySection() {
  const setting = useSettingDefinition(additionalSettings.buddyWorkspaceDirectory);
  const { t } = useTranslation();
  const [state, setState] = useState<BuddyWorkspaceSettingsState | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const revision = useRef(0);
  const api = window.electronAPI.buddyWorkspace;

  useEffect(() => {
    if (!api) return;
    let active = true;
    const request = ++revision.current;
    void api
      .get()
      .then((value) => {
        if (active && request === revision.current) setState(value);
      })
      .catch((error) => {
        if (active) {
          toast.error(
            t(
              mapIpcErrorToI18nKey(error, {
                fallback: 'settings.about.storage.buddyWorkspaceDirectoryFailed',
              }),
            ),
          );
        }
      });
    return () => {
      active = false;
      revision.current += 1;
    };
  }, [api, t]);

  const update = async (action: 'choose' | 'reset') => {
    if (!api || pending.current) return;
    pending.current = true;
    const request = ++revision.current;
    setBusy(true);
    try {
      const value = await api[action]();
      if (request === revision.current) setState(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('TARGET_OVERLAPS_CINDY_DATA')) {
        toast.error(t('bots.homeFolder.workspaceLocation.errors.overlapsCindyData'));
      } else if (message.includes('LOCAL_DISK_REQUIRED')) {
        toast.error(t('bots.homeFolder.workspaceLocation.errors.localDiskRequired'));
      } else {
        toast.error(
          t(
            mapIpcErrorToI18nKey(error, {
              fallback: 'settings.about.storage.buddyWorkspaceDirectoryFailed',
            }),
          ),
        );
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const copyPath = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t('settings.about.storage.dialogueDirectoryCopied'));
    } catch {
      toast.error(t('settings.about.storage.dialogueDirectoryCopyFailed'));
    }
  };

  const openDirectory = async () => {
    if (!api || !state) return;
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
      <div className="flex flex-col gap-3 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span
                role="heading"
                aria-level={3}
                className="text-13 font-medium leading-[1.4] text-[var(--settings-section-title)]"
              >
                {setting.title}
              </span>
              {state ? (
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-11 font-medium',
                    state.isCustomized
                      ? 'text-[var(--text-primary)]'
                      : 'text-[var(--text-secondary)]',
                  )}
                >
                  <span
                    className={cn(
                      'size-1.5 shrink-0 rounded-full',
                      state.isCustomized
                        ? 'bg-[var(--status-info)]'
                        : 'bg-[var(--text-tertiary)]',
                    )}
                    aria-hidden
                  />
                  {t(
                    state.isCustomized
                      ? 'settings.defaults.customizedBadge'
                      : 'settings.about.storage.dialogueDirectoryDefault',
                  )}
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-12 leading-[1.45] text-[var(--text-secondary)] [text-wrap:pretty]">
              {setting.description}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2 pt-0.5">
            {state?.isCustomized ? (
              <Tip text={t('settings.about.storage.dialogueDirectoryReset')}>
                <Button
                  {...setting.controlProps}
                  variant="secondary"
                  tone="quiet"
                  size="sm"
                  className="w-7 px-0"
                  disabled={busy}
                  aria-label={t('settings.about.storage.dialogueDirectoryReset')}
                  onClick={() => void update('reset')}
                >
                  <RotateCcw size={14} aria-hidden />
                </Button>
              </Tip>
            ) : null}
            <Button
              {...setting.controlProps}
              variant="secondary"
              size="sm"
              compact
              className="gap-1.5"
              disabled={busy}
              onClick={() => void update('choose')}
            >
              <FolderInput size={13} aria-hidden />
              {t('settings.about.storage.buddyWorkspaceDirectoryChoose')}
            </Button>
          </div>
        </div>

        {state ? (
          <WorkspacePathField
            path={state.directory}
            fullPathLabel={t('settings.about.storage.dialogueDirectoryFullPath')}
            detailsText={t('settings.about.storage.buddyWorkspaceDirectoryDetails')}
            copyLabel={t('settings.about.storage.dialogueDirectoryCopy')}
            openLabel={t('settings.about.storage.dialogueDirectoryOpen')}
            onCopy={copyPath}
            onOpen={openDirectory}
            disabled={busy}
            controlProps={setting.controlProps}
          />
        ) : null}
      </div>
    </SettingsCard>
  );
}
