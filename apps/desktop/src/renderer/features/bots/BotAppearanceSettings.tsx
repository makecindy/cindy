import { useEffect, useMemo, useReducer } from 'react';

import { Select } from '@/components/ui/select';
import { SettingsCard, SettingsRow } from '@/components/ui/settings-rows';
import { getThemeFamilies, tryGetFamily, type ThemeFamily } from '@/themes/families';
import { onLocalThemesChange } from '@/themes/local-themes';
import { SELECTABLE_WALLPAPER_IDS, RETIRED_WALLPAPER_IDS } from '@/../shared/appearanceSettings';
import { isLocalThemeId } from '../../../shared/local-themes';

import { useBotTranslation } from './botPronounContext';
import { isBotWallpaperId, setBotAppearance, useBotAppearance, type BotWallpaperId } from './botAppearance';

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
    const ids: BotWallpaperId[] = SELECTABLE_WALLPAPER_IDS.flatMap((id) => (id === 'custom' ? [] : [id]));
    const retired = RETIRED_WALLPAPER_IDS.find((id) => id === appearance.wallpaperId);
    return retired ? [ids[0]!, retired, ...ids.slice(1)] : ids;
  }, [appearance.wallpaperId]);
  const wallpaperValue = appearance.wallpaperId ?? FOLLOW;

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
              onValueChange={(value) =>
                setBotAppearance(botId, { wallpaperId: value !== FOLLOW && isBotWallpaperId(value) ? value : null })
              }
            />
          }
        />
      </SettingsCard>
    </div>
  );
}
