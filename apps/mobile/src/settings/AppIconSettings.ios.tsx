import { useTranslation } from 'react-i18next';
import { Alert, Image, Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/AppText';
import { SettingsGroup, useSettingsRowStyles } from '@/session/SettingsGroupRows';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { radius, spacing } from '@/theme/tokens';

import { type AppIconChoice } from './appIconPreference';
import { defaultIconAsset, wordmarkDarkAsset, wordmarkLightAsset } from './appIconAssets';
import { useAppIcon } from './useAppIcon';

/** iOS 设置行：默认 / Cindy 字标两个图标瓦片，切换即时生效并写入本机偏好。 */
export function AppIconSettings() {
  const { t } = useTranslation();
  const { mode } = useTheme();
  const rowStyles = useSettingsRowStyles();
  const styles = useThemedStyles(makeStyles);
  const { choice, supported, pending, select } = useAppIcon();

  if (!supported) return null;

  const options: ReadonlyArray<{ key: AppIconChoice; label: string; source: number }> = [
    {
      key: 'default',
      label: t('settings.appearance.appIcon.options.default'),
      source: defaultIconAsset,
    },
    {
      key: 'wordmark',
      label: t('settings.appearance.appIcon.options.wordmark'),
      source: mode === 'dark' ? wordmarkDarkAsset : wordmarkLightAsset,
    },
  ];

  const handleSelect = async (next: AppIconChoice) => {
    const result = await select(next);
    if (result === 'set-failed') {
      Alert.alert(
        t('settings.appearance.appIcon.label'),
        t('settings.appearance.appIcon.setFailed'),
      );
    } else if (result === 'save-failed') {
      Alert.alert(
        t('settings.appearance.appIcon.label'),
        t('settings.appearance.appIcon.saveFailed'),
      );
    }
  };

  return (
    <SettingsGroup
      footer={t('settings.appearance.appIcon.hint')}
      title={t('settings.appearance.appIcon.label')}
    >
      <View style={rowStyles.row} testID="settings.appIcon">
        <View style={rowStyles.rowLine}>
          <Text style={rowStyles.rowLabel}>
            {t('settings.appearance.appIcon.rowLabel')}
          </Text>
          <View accessibilityRole="radiogroup" style={styles.tiles}>
            {options.map((option) => {
              const checked = choice === option.key;
              return (
                <Pressable
                  accessibilityLabel={option.label}
                  accessibilityRole="radio"
                  accessibilityState={{ checked, disabled: pending }}
                  disabled={pending}
                  key={option.key}
                  onPress={() => void handleSelect(option.key)}
                  style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
                  testID={`settings.appIcon.option.${option.key}`}
                >
                  <Image source={option.source} style={styles.tileImage} />
                  {checked ? <View pointerEvents="none" style={styles.tileRing} /> : null}
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>
    </SettingsGroup>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    tiles: { flexDirection: 'row', gap: spacing.sm },
    tile: {
      borderRadius: radius.container,
      height: 44,
      overflow: 'hidden',
      width: 44,
    },
    tileImage: { height: 44, width: 44 },
    tilePressed: { opacity: 0.72 },
    tileRing: {
      borderColor: colors.textPrimary,
      borderRadius: radius.container,
      borderWidth: 2,
      bottom: 0,
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
    },
  });
