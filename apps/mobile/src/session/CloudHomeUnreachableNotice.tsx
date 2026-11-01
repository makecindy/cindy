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
import { isDurableOutboxHandedOff, type DurableOutboxRecord } from './durableOutbox';
import type { MobileOutboxConnectionState } from './sessionOutbox';

/** How long a message may wait for the main computer before the switch is offered. */
export const CLOUD_HOME_UNREACHABLE_AFTER_MS = 15_000;

/**
 * A message of this chat has not been handed to the main computer yet, and only because that computer
 * is unreachable: the phone is connected, but presence says it is offline or it stopped answering.
 * Messages the computer already took (awaiting history confirmation or cleanup) and holds for the
 * phone's own sync or reconnect do not count — switching computers would not help with those.
 */
export function isMessageWaitingForCloudHome(
  records: readonly Pick<DurableOutboxRecord, 'deviceId' | 'item' | 'state' | 'retrySafe' | 'historyConfirmed' | 'cleanupOutcome' | 'cancelRequested' | 'suspended'>[],
  target: { deviceId: string; sessionId: string },
  connection: Pick<MobileOutboxConnectionState, 'relayOnline' | 'targetAvailable' | 'deviceUnresponsive'>,
): boolean {
  if (!connection.relayOnline || (connection.targetAvailable !== false && !connection.deviceUnresponsive)) return false;
  return records.some(record => record.deviceId === target.deviceId && record.item.sessionId === target.sessionId
    && !isDurableOutboxHandedOff(record) && !record.cancelRequested && !record.suspended);
}

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
