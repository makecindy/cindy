import { useEffect, useRef, useState } from 'react';
import { Alert, Image, Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { AppIcon } from '@cindy/maker-shared';
import { Text } from '@/components/AppText';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { applyAppIcon, readAppIconState, type AppIconState } from '@/platform/appIcon';
import { useSettingsRowStyles } from '@/session/SettingsGroupRows';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { radius, spacing } from '@/theme/tokens';
import { APP_ICON_PREVIEWS } from './appIconPreviews.generated';

export interface AppIconChoice {
  state: AppIconState;
  select(icon: AppIcon): void;
}

/**
 * Null where the installed build cannot switch icons (Android, older builds),
 * so the settings page can leave the row out instead of showing an empty one.
 */
export function useAppIconChoice(): AppIconChoice | null {
  const { t } = useTranslation();
  const [state, setState] = useState<AppIconState | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    let active = true;
    void readAppIconState().then((next) => {
      if (active) setState(next);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!state) return null;
  const select = (icon: AppIcon) => {
    if (icon === state.current) return;
    const previous = state.current;
    const request = ++requestRef.current;
    setState({ ...state, current: icon });
    applyAppIcon(icon).catch(() => {
      // A newer tap owns the selection; only the latest failure rolls back.
      if (request !== requestRef.current) return;
      setState((latest) => (latest ? { ...latest, current: previous } : latest));
      Alert.alert(
        t('settings.appearance.appIcon.label'),
        t('settings.appearance.appIcon.saveFailed'),
      );
    });
  };
  return { state, select };
}

/**
 * Home screen icon choice, the phone counterpart of the Desktop Dock icon row:
 * same choices and artwork, from the shared list.
 */
export function AppIconSettings({ choice }: { choice: AppIconChoice }) {
  const { t } = useTranslation();
  const { colors, mode } = useTheme();
  const rowStyles = useSettingsRowStyles();
  const styles = useThemedStyles(makeStyles);
  const { state, select } = choice;
  const label = t('settings.appearance.appIcon.label');
  // Which artwork the home screen shows depends on its icon style, which an
  // app cannot read; preview by the app theme, as the system's own
  // confirmation alert does.
  const dark = state.darkArtwork && mode === 'dark';

  return (
    <View style={[rowStyles.row, styles.row]} testID="settings.appIcon">
      <Text style={[rowStyles.rowLabel, styles.label]}>{label}</Text>
      <View accessibilityLabel={label} accessibilityRole="radiogroup" style={styles.icons}>
        {state.icons.map((icon) => {
          const selected = icon === state.current;
          return (
            <Pressable
              accessibilityLabel={t(`settings.appearance.appIcon.options.${icon}`)}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              key={icon}
              onPress={() => select(icon)}
              style={({ pressed }) => [
                styles.tile,
                selected && { borderColor: colors.textSecondary },
                pressed && mobileInteractionStyles.pressed,
              ]}
              testID={`settings.appIcon.${icon}`}
            >
              <Image
                source={dark ? APP_ICON_PREVIEWS[icon].dark : APP_ICON_PREVIEWS[icon].light}
                style={styles.artwork}
              />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// 52pt tile (44pt artwork plus the selection ring) keeps the touch target
// above 44pt; ring and artwork use concentric container / control corners.
const TILE = 52;
const RING = 2;
const ARTWORK = 44;

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    row: { gap: spacing.md },
    // The shared label style stretches along a horizontal row; stacked above
    // the icons it must keep its own text height instead.
    label: { flex: 0 },
    icons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    tile: {
      alignItems: 'center',
      borderColor: 'transparent',
      borderRadius: radius.container,
      borderWidth: RING,
      height: TILE,
      justifyContent: 'center',
      width: TILE,
    },
    artwork: {
      backgroundColor: colors.surface,
      borderRadius: radius.control,
      height: ARTWORK,
      width: ARTWORK,
    },
  });
