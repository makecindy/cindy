import AsyncStorage from '@react-native-async-storage/async-storage';
import { compareFailedScheduleRuns, scheduleFailureMessageKey, type FailedScheduleRunSnapshot } from '@cindy/maker-shared/schedule-model';
import { CircleAlert, X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { iconSize, iconStroke, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

/** Only a local display preference: never writes a run or a read receipt. */
export function FailedScheduleNotice({ source, run, onViewHistory }: { source: string; run: FailedScheduleRunSnapshot; onViewHistory?: () => void }) {
  const key = `scheduleFailureDismissal:${source}`;
  const [loaded, setLoaded] = useState(false);
  const [dismissed, setDismissed] = useState<FailedScheduleRunSnapshot | null>(null);
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  useEffect(() => {
    let active = true;
    setLoaded(false);
    setDismissed(null);
    void AsyncStorage.getItem(key).then((raw) => {
      if (!active || !raw) return;
      try {
        const value = JSON.parse(raw);
        if (typeof value?.runId === 'string' && typeof value.firedAt === 'number' && Number.isFinite(value.firedAt)) setDismissed(value);
      } catch { /* Invalid preferences do not hide history. */ }
    }).catch(() => undefined).finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, [key]);
  if (!loaded || (dismissed && compareFailedScheduleRuns(dismissed, run) >= 0)) return null;
  const dismiss = () => {
    setDismissed(run);
    void AsyncStorage.setItem(key, JSON.stringify(run)).catch(() => undefined);
  };
  return (
    <View style={styles.box} testID="session.failedScheduleNotice">
      <CircleAlert color={colors.errorText} size={iconSize.md} strokeWidth={iconStroke.regular} />
      <View style={styles.content}>
        <Text style={styles.text}>{t(`session.failedScheduleNotice.${scheduleFailureMessageKey(run)}`)}</Text>
        {onViewHistory && <Pressable accessibilityRole="button" onPress={onViewHistory}
          style={({ pressed }) => [styles.history, pressed && styles.pressed]}>
          <Text style={styles.historyText}>{t('session.failedScheduleNotice.viewHistory')}</Text>
        </Pressable>}
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel={t('session.failedScheduleNotice.dismissTitle')}
        onPress={dismiss} style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
        <X color={colors.errorText} size={iconSize.md} strokeWidth={iconStroke.regular} />
      </Pressable>
    </View>
  );
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  box: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm,
    paddingLeft: spacing.md, backgroundColor: colors.surfaceElevated, borderColor: colors.errorBorder,
    borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.container },
  content: { flex: 1 },
  text: { color: colors.errorText, fontSize: typeScale.caption, lineHeight: lineHeight.caption, paddingVertical: spacing.sm },
  history: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', paddingHorizontal: spacing.sm, borderRadius: radius.pill },
  historyText: { color: colors.errorText, fontSize: typeScale.caption, textDecorationLine: 'underline' },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill },
  pressed: { opacity: 0.7 },
});
