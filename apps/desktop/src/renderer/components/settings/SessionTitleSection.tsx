/**
 * Session automatic naming preferences and the explicit bulk-retitling entry.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Select } from '@/components/ui/select';
import { toast } from '@/lib/toast';
import { DefaultOverrideControls } from './DefaultOverrideControls';

type Style = 'concise' | 'goal-summary' | 'raw';
type Language = 'auto' | 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'ko';

interface Settings {
  style: Style;
  language: Language;
}

const DEFAULT_SETTINGS: Settings = { style: 'concise', language: 'auto' };
const STYLES: Style[] = ['concise', 'goal-summary', 'raw'];
const LANGUAGES: Language[] = ['auto', 'zh-CN', 'zh-TW', 'en', 'ja', 'ko'];

function isPreferenceChanged(current: Settings, next: Settings): boolean {
  return current.style !== next.style || current.language !== next.language;
}

export function SessionTitleSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [isCustomized, setIsCustomized] = useState(false);
  const [pending, setPending] = useState(false);
  const [retitleOpen, setRetitleOpen] = useState(false);

  useEffect(() => {
    let disposed = false;
    window.electronAPI.maker
      .getSessionTitleSettings()
      .then((state) => {
        if (disposed) return;
        setSettings(state.value);
        setIsCustomized(state.isCustomized);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, []);

  const savePreference = useCallback(
    async (patch: Partial<Settings>) => {
      setPending(true);
      try {
        const next = await window.electronAPI.maker.setSessionTitleSettings(patch);
        const changed = isPreferenceChanged(settings, next);
        setSettings(next);
        setIsCustomized(next.style !== DEFAULT_SETTINGS.style || next.language !== DEFAULT_SETTINGS.language);
        if (changed) setRetitleOpen(true);
      } catch {
        toast.error(t('settings.sessionTitle.toast.saveFailed'));
      } finally {
        setPending(false);
      }
    },
    [settings, t],
  );

  const resetPreference = useCallback(async () => {
    setPending(true);
    try {
      const next = await window.electronAPI.maker.resetSessionTitleSettings();
      const changed = isPreferenceChanged(settings, next);
      setSettings(next);
      setIsCustomized(false);
      if (changed) setRetitleOpen(true);
      toast.success(t('settings.defaults.restored'));
    } catch {
      toast.error(t('settings.sessionTitle.toast.saveFailed'));
    } finally {
      setPending(false);
    }
  }, [settings, t]);

  const runRetitle = useCallback(
    async (windowDays: 7 | 30) => {
      setRetitleOpen(false);
      setPending(true);
      try {
        const result = await window.electronAPI.maker.retitleRecentSessions(windowDays);
        toast.success(
          t('settings.sessionTitle.toast.renamed', {
            renamed: result.renamed,
            total: result.total,
          }),
        );
      } catch {
        toast.error(t('settings.sessionTitle.toast.retitleFailed'));
      } finally {
        setPending(false);
      }
    },
    [t],
  );

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex flex-col gap-1">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          {t('settings.sessionTitle.title')}
        </h2>
      </div>

      <div className="flex flex-col gap-[14px] rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-14 font-medium leading-[1.3] text-[var(--text-primary)]">
              {t('settings.sessionTitle.styleLabel')}
            </p>
            <p className="mt-1 text-12 leading-[1.5] text-[var(--text-secondary)]">
              {t('settings.sessionTitle.styleHint')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <DefaultOverrideControls isCustomized={isCustomized} disabled={pending} onReset={() => void resetPreference()} />
          </div>
        </div>

        <div className="grid gap-2">
          {STYLES.map((style) => (
            <label
              key={style}
              className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-[var(--surface-hover)]"
            >
              <input
                type="radio"
                name="session-title-style"
                checked={settings.style === style}
                disabled={pending}
                onChange={() => void savePreference({ style })}
                className="mt-[3px] cursor-pointer accent-[var(--settings-menu-text-selected)]"
              />
              <span className="flex min-w-0 flex-col">
                <span className="text-13 font-medium leading-[1.3] text-[var(--text-primary)]">
                  {t(`settings.sessionTitle.styles.${style}.label`)}
                </span>
                <span className="mt-0.5 text-12 leading-[1.4] text-[var(--text-secondary)]">
                  {t(`settings.sessionTitle.styles.${style}.description`)}
                </span>
              </span>
            </label>
          ))}
        </div>

        <div className="flex flex-wrap items-end justify-between gap-3 border-t border-[var(--settings-theme-card-border)] pt-4">
          <div className="min-w-[220px] flex-1">
            <p className="text-13 font-medium leading-[1.3] text-[var(--text-primary)]">
              {t('settings.sessionTitle.languageLabel')}
            </p>
            <p className="mt-1 text-12 leading-[1.4] text-[var(--text-secondary)]">
              {t('settings.sessionTitle.languageHint')}
            </p>
          </div>
          <Select
            label={t('settings.sessionTitle.languageLabel')}
            value={settings.language}
            disabled={pending || settings.style === 'raw'}
            options={LANGUAGES.map((language) => ({
              value: language,
              label: t(`settings.sessionTitle.languages.${language}`),
            }))}
            onValueChange={(value) => void savePreference({ language: value as Language })}
            className="w-[190px]"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--settings-theme-card-border)] pt-4">
          <div className="min-w-[220px] flex-1">
            <p className="text-13 font-medium leading-[1.3] text-[var(--text-primary)]">
              {t('settings.sessionTitle.retitleLabel')}
            </p>
            <p className="mt-1 text-12 leading-[1.4] text-[var(--text-secondary)]">
              {t('settings.sessionTitle.retitleHint')}
            </p>
          </div>
          <Button
            variant="secondary"
            size="md"
            disabled={pending}
            onClick={() => setRetitleOpen(true)}
          >
            {t('settings.sessionTitle.retitleAction')}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={retitleOpen}
        onOpenChange={(open) => setRetitleOpen(open)}
        title={t('settings.sessionTitle.dialog.title')}
        description={t('settings.sessionTitle.dialog.description')}
        confirmText={t('settings.sessionTitle.dialog.sevenDays')}
        tertiaryText={t('settings.sessionTitle.dialog.thirtyDays')}
        cancelText={t('settings.sessionTitle.dialog.notNow')}
        autoFocusConfirm
        onConfirm={() => void runRetitle(7)}
        onTertiary={() => void runRetitle(30)}
        onCancel={() => setRetitleOpen(false)}
      />
    </div>
  );
}
