import { useEffect, useMemo, useReducer, useState } from 'react';
import { ImagePlus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';
import { extractIpcError } from '@/utils/ipcError';

import { Select } from '@/components/ui/select';
import { SettingsCard, SettingsRow } from '@/components/ui/settings-rows';
import { getThemeFamilies, tryGetFamily, type ThemeFamily } from '@/themes/families';
import { onLocalThemesChange } from '@/themes/local-themes';
import { SELECTABLE_WALLPAPER_IDS, RETIRED_WALLPAPER_IDS } from '@/../shared/appearanceSettings';
import { isLocalThemeId } from '../../../shared/local-themes';

import { useBotTranslation } from './botPronounContext';
import {
  importBotCustomWallpaper,
  isBotWallpaperId,
  removeBotCustomWallpaper,
  setBotAppearance,
  useBotAppearance,
  useBotCustomWallpaperUrl,
  type BotWallpaperId,
} from './botAppearance';

/** Radix Select needs a non-empty value; real family and wallpaper IDs never start with a colon. */
const FOLLOW = ':follow';

/**
 * 伙伴「外观」页：主题、壁纸各一行，默认跟随全局。只在本机生效，改动即时作用于背后的对话。
 */
export function BotAppearanceSettings({ botId }: { botId: string }) {
  const { t } = useBotTranslation();
  const appearance = useBotAppearance(botId);
  const [localThemesVersion, bumpLocalThemes] = useReducer((n: number) => n + 1, 0);
  useEffect(() => onLocalThemesChange(bumpLocalThemes), []);
  const families = useMemo<ThemeFamily[]>(() => {
    void localThemesVersion;
    return getThemeFamilies();
  }, [localThemesVersion]);
  const familyLabel = (family: ThemeFamily) =>
    isLocalThemeId(family.id) ? `${family.name} ${t('settings.appearance.localBadge')}` : family.name;
  // A removed local theme no longer applies; show the row as following the global theme.
  const familyValue = appearance.familyId && tryGetFamily(appearance.familyId) ? appearance.familyId : FOLLOW;

  // A retired wallpaper stays listed only while this teammate still uses it, like the global picker.
  const wallpaperIds = useMemo<BotWallpaperId[]>(() => {
    const ids: BotWallpaperId[] = [...SELECTABLE_WALLPAPER_IDS];
    const retired = RETIRED_WALLPAPER_IDS.find((id) => id === appearance.wallpaperId);
    return retired ? [ids[0]!, retired, ...ids.slice(1)] : ids;
  }, [appearance.wallpaperId]);
  const customUrl = useBotCustomWallpaperUrl(botId);
  // Custom without its media is shown (and applied) as following the global wallpaper.
  const wallpaperValue =
    appearance.wallpaperId === 'custom' && !customUrl ? FOLLOW : (appearance.wallpaperId ?? FOLLOW);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const chooseImage = async () => {
    setBusy(true);
    setError('');
    try {
      if (await importBotCustomWallpaper(botId)) setBotAppearance(botId, { wallpaperId: 'custom' });
    } catch (failure) {
      setError(
        t(
          extractIpcError(failure)?.code === 'INVALID_PARAMS'
            ? 'settings.appearance.wallpaper.customInvalid'
            : 'settings.appearance.wallpaper.customFailed',
        ),
      );
    } finally {
      setBusy(false);
    }
  };
  const removeImage = async () => {
    setBusy(true);
    setError('');
    try {
      await removeBotCustomWallpaper(botId);
      if (appearance.wallpaperId === 'custom') setBotAppearance(botId, { wallpaperId: null });
    } catch {
      setError(t('settings.appearance.wallpaper.customFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pt-3">
      <p className="mb-3 px-1 text-12 leading-5 text-[var(--text-secondary)]">
        {t('bots.appearance.hint')}
      </p>
      <SettingsCard>
        <SettingsRow
          title={t('bots.appearance.theme')}
          wrap
          trailing={
            <Select
              data-settings-search-action="Teammate appearance lives in its own settings drawer, outside the settings index"
              label={t('bots.appearance.theme')}
              value={familyValue}
              options={[
                { value: FOLLOW, label: t('bots.appearance.followGlobal') },
                ...families.map((family) => ({ value: family.id, label: familyLabel(family) })),
              ]}
              truncateOptions
              size="compact"
              width="sm"
              className="shrink-0"
              onValueChange={(value) => setBotAppearance(botId, { familyId: value === FOLLOW ? null : value })}
            />
          }
        />
        <SettingsRow
          title={t('bots.appearance.wallpaper')}
          wrap
          trailing={
            <Select
              data-settings-search-action="Teammate appearance lives in its own settings drawer, outside the settings index"
              label={t('bots.appearance.wallpaper')}
              value={wallpaperValue}
              options={[
                { value: FOLLOW, label: t('bots.appearance.followGlobal') },
                ...wallpaperIds.map((id) => ({ value: id, label: t('settings.appearance.wallpaper.options.' + id) })),
              ]}
              truncateOptions
              size="compact"
              width="sm"
              className="shrink-0"
              onValueChange={(value) => {
                // Picking custom before this teammate has its own image opens the file picker first.
                if (value === 'custom' && !customUrl) {
                  void chooseImage();
                  return;
                }
                setBotAppearance(botId, { wallpaperId: value !== FOLLOW && isBotWallpaperId(value) ? value : null });
              }}
            />
          }
        />
        <SettingsRow
          title={t('settings.appearance.wallpaper.options.custom')}
          hint={t('settings.appearance.wallpaper.customHint')}
          wrap
          trailing={
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" type="button" disabled={busy} onClick={() => void chooseImage()}>
                <ImagePlus size={14} aria-hidden="true" />
                {t(`settings.appearance.wallpaper.${busy ? 'customBusy' : customUrl ? 'customReplace' : 'customChoose'}`)}
              </Button>
              {customUrl && (
                <Button
                  variant="secondary"
                  tone="danger"
                  size="sm"
                  type="button"
                  disabled={busy}
                  onClick={() => void removeImage()}
                >
                  {t('settings.appearance.wallpaper.customRemove')}
                </Button>
              )}
            </div>
          }
        />
      </SettingsCard>
      {error && <ErrorNotice role="alert" className="mt-3" message={error} />}
    </div>
  );
}
