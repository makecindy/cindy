import { useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { ChoicePickerRow } from '@/session/SettingsGroupRows';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { radius, spacing } from '@/theme/tokens';
import { APP_ICON_PREVIEWS } from './appIconPreviews.generated';

export { useAppIconChoice } from './useAppIconChoice';
import type { AppIconChoice } from './useAppIconChoice';

/**
 * Home screen icon choice, the phone counterpart of the Desktop Dock icon row:
 * same choices and artwork, from the shared list.
 */
export function AppIconSettings({ choice }: { choice: AppIconChoice }) {
  const { t } = useTranslation();
  const { colors, mode } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const styles = useThemedStyles(makeStyles);
  const { state, select } = choice;
  const label = t('settings.appearance.appIcon.label');
  // Which artwork the home screen shows depends on its icon style, which an
  // app cannot read; preview by the app theme, as the system's own
  // confirmation alert does.
  const dark = state.darkArtwork && mode === 'dark';

  return (
    <View testID="settings.appIcon">
      <ChoicePickerRow expanded={expanded} label={label}
        value={t(`settings.appearance.appIcon.options.${state.current}`)}
        onPress={() => setExpanded(open => !open)} testID="settings.appIcon.open" />
      {expanded && <View accessibilityLabel={label} accessibilityRole="radiogroup" style={styles.icons}>
        {state.icons.map((icon) => {
          const selected = icon === state.current;
          return (
            <Pressable
              accessibilityLabel={t(`settings.appearance.appIcon.options.${icon}`)}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              key={icon}
              onPress={() => { setExpanded(false); select(icon); }}
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
      </View>}
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
    icons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
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
