/**
 * 云端伙伴的消息发不出去时才出现的提示（docs/product-rules/cloud-companions.md §3.1）：像 IM 一样，
 * 主力电脑一时连不上不打扰浏览；只有发出的消息持续送不到主力电脑，才提示「主力电脑「X」连不上」并提供
 * 换一台电脑继续（打开云端对话页里的换电脑流程）。
 */
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { lineHeight, radius, spacing, typeScale, useThemedStyles, type ThemeColors } from '@/theme';
import { CompanionCardButton } from './CompanionCardButton';

/** How long a message may wait for the main computer before the switch is offered. */
export const CLOUD_HOME_UNREACHABLE_AFTER_MS = 15_000;

/** True once `waiting` has held continuously for `afterMs` (a message cannot reach the computer). */
export function useSustained(waiting: boolean, afterMs = CLOUD_HOME_UNREACHABLE_AFTER_MS): boolean {
  const [sustained, setSustained] = useState(false);
  useEffect(() => {
    if (!waiting) { setSustained(false); return; }
    const timer = setTimeout(() => setSustained(true), afterMs);
    return () => clearTimeout(timer);
  }, [afterMs, waiting]);
  return waiting && sustained;
}

export function CloudHomeUnreachableNotice({ deviceName, onSwitch }: { deviceName: string; onSwitch(): void }) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.card} accessibilityRole="alert" testID="cloudHome.unreachable">
    <Text style={styles.copy}>{t('devices.cloudCompanion.sendUnreachable', { device: deviceName })}</Text>
    <CompanionCardButton primary label={t('devices.cloudCompanion.switchAction')} onPress={onSwitch} testID="cloudHome.unreachable.switch" />
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  card: {
    gap: spacing.sm, marginHorizontal: spacing.lg, marginTop: spacing.sm, padding: spacing.md,
    borderRadius: radius.container, backgroundColor: colors.surfaceElevated,
  },
  copy: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
});
