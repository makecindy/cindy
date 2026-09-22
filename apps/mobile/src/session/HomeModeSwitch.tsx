import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { MainWindowOptionButton } from '@/components/MobilePrimitives';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { radius, spacing } from '@/theme/tokens';
import type { HomeMode } from './homeViewPreferenceStore';

export function HomeModeSwitch({ mode, onModeChange }: { mode: HomeMode; onModeChange(mode: HomeMode): void }) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.switch} testID="home.modeSwitch">
      {(['tasks', 'teammates'] as const).map((value) => (
        <MainWindowOptionButton key={value} accessibilityRole="tab" density="default" variant="segmented"
          label={t(value === 'tasks' ? 'devices.companions.tasks' : 'devices.companions.title')}
          onPress={() => onModeChange(value)} selected={value === mode} style={styles.option}
          testID={`home.mode.${value}`} />
      ))}
    </View>
  );
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  switch: { flexDirection: 'row', backgroundColor: colors.surfaceChip, borderRadius: radius.pill, margin: spacing.lg, padding: spacing.xs },
  option: { flex: 1, minHeight: 44 },
});
